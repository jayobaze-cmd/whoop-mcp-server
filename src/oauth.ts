import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { WhoopDatabase } from './database.js';

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SCOPE = 'whoop:read';

export interface PendingAuthorization {
	clientId: string;
	redirectUri: string;
	clientState?: string;
	codeChallenge?: string;
	scope: string;
	createdAt: number;
}

interface IssuedCode {
	clientId: string;
	redirectUri: string;
	codeChallenge?: string;
	scope: string;
	createdAt: number;
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function generateSecret(prefix: string): string {
	return `${prefix}_${randomBytes(32).toString('hex')}`;
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
	return createHash('sha256').update(codeVerifier).digest('base64url') === codeChallenge;
}

function isValidRedirectUri(uri: string): boolean {
	try {
		const parsed = new URL(uri);
		if (parsed.protocol === 'https:') return true;
		return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
	} catch {
		return false;
	}
}

function errorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
	const url = new URL(redirectUri);
	url.searchParams.set('error', error);
	url.searchParams.set('error_description', description);
	if (state) url.searchParams.set('state', state);
	return url.toString();
}

export class McpOAuth {
	private readonly pending = new Map<string, PendingAuthorization>();
	private readonly codes = new Map<string, IssuedCode>();

	constructor(private readonly db: WhoopDatabase) {}

	cleanup(): void {
		const now = Date.now();
		for (const [key, value] of this.pending) {
			if (now - value.createdAt > PENDING_AUTH_TTL_MS) this.pending.delete(key);
		}
		for (const [key, value] of this.codes) {
			if (now - value.createdAt > AUTH_CODE_TTL_MS) this.codes.delete(key);
		}
		this.db.deleteExpiredOAuthTokens(now);
	}

	protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
		return {
			resource: `${baseUrl}/mcp`,
			authorization_servers: [baseUrl],
			bearer_methods_supported: ['header'],
			scopes_supported: [DEFAULT_SCOPE],
			resource_name: 'Whoop MCP Server',
		};
	}

	authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
		return {
			issuer: baseUrl,
			authorization_endpoint: `${baseUrl}/authorize`,
			token_endpoint: `${baseUrl}/token`,
			registration_endpoint: `${baseUrl}/register`,
			response_types_supported: ['code'],
			response_modes_supported: ['query'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
			code_challenge_methods_supported: ['S256'],
			scopes_supported: [DEFAULT_SCOPE],
		};
	}

	handleRegister(req: Request, res: Response): void {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const redirectUris = body.redirect_uris;

		if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(uri => typeof uri === 'string' && isValidRedirectUri(uri))) {
			res.status(400).json({
				error: 'invalid_redirect_uri',
				error_description: 'redirect_uris must be a non-empty array of https URLs (or http://localhost)',
			});
			return;
		}

		const requestedAuthMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
		const authMethod = ['none', 'client_secret_post', 'client_secret_basic'].includes(requestedAuthMethod) ? requestedAuthMethod : 'none';
		const clientId = randomBytes(16).toString('hex');
		const clientSecret = authMethod === 'none' ? null : generateSecret('mcs');
		const clientName = typeof body.client_name === 'string' ? body.client_name : null;

		this.db.saveOAuthClient({
			clientId,
			clientSecret,
			redirectUris: redirectUris as string[],
			clientName,
			tokenEndpointAuthMethod: authMethod,
		});

		const response: Record<string, unknown> = {
			client_id: clientId,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			redirect_uris: redirectUris,
			token_endpoint_auth_method: authMethod,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
		};
		if (clientName) response.client_name = clientName;
		if (clientSecret) {
			response.client_secret = clientSecret;
			response.client_secret_expires_at = 0;
		}

		res.status(201).json(response);
	}

	/**
	 * Validates the authorization request and returns the state key to pass to
	 * Whoop as OAuth state. Sends the error response itself and returns null on failure.
	 */
	beginAuthorization(req: Request, res: Response): string | null {
		const query = req.query as Record<string, string | undefined>;
		const clientId = query.client_id;
		const redirectUri = query.redirect_uri;

		if (!clientId || !redirectUri) {
			res.status(400).json({ error: 'invalid_request', error_description: 'client_id and redirect_uri are required' });
			return null;
		}

		const client = this.db.getOAuthClient(clientId);
		if (!client) {
			res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id. Register via /register first.' });
			return null;
		}

		if (!client.redirectUris.includes(redirectUri)) {
			res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri does not match a registered redirect URI' });
			return null;
		}

		if (query.response_type !== 'code') {
			res.redirect(errorRedirect(redirectUri, 'unsupported_response_type', 'Only response_type=code is supported', query.state));
			return null;
		}

		if (query.code_challenge && query.code_challenge_method && query.code_challenge_method !== 'S256') {
			res.redirect(errorRedirect(redirectUri, 'invalid_request', 'Only S256 code_challenge_method is supported', query.state));
			return null;
		}

		const stateKey = randomBytes(16).toString('hex');
		this.pending.set(stateKey, {
			clientId,
			redirectUri,
			clientState: query.state,
			codeChallenge: query.code_challenge,
			scope: query.scope || DEFAULT_SCOPE,
			createdAt: Date.now(),
		});

		return stateKey;
	}

	takePending(state: string): PendingAuthorization | undefined {
		const pending = this.pending.get(state);
		if (!pending) return undefined;
		this.pending.delete(state);
		if (Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) return undefined;
		return pending;
	}

	buildSuccessRedirect(pending: PendingAuthorization): string {
		const code = generateSecret('mcc');
		this.codes.set(code, {
			clientId: pending.clientId,
			redirectUri: pending.redirectUri,
			codeChallenge: pending.codeChallenge,
			scope: pending.scope,
			createdAt: Date.now(),
		});

		const url = new URL(pending.redirectUri);
		url.searchParams.set('code', code);
		if (pending.clientState) url.searchParams.set('state', pending.clientState);
		return url.toString();
	}

	buildErrorRedirect(pending: PendingAuthorization, error: string, description: string): string {
		return errorRedirect(pending.redirectUri, error, description, pending.clientState);
	}

	handleToken(req: Request, res: Response): void {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const grantType = body.grant_type;

		const clientId = this.authenticateClient(req, res);
		if (clientId === null) return;

		if (grantType === 'authorization_code') {
			this.handleAuthorizationCodeGrant(clientId, body, res);
		} else if (grantType === 'refresh_token') {
			this.handleRefreshTokenGrant(clientId, body, res);
		} else {
			res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Supported grant types: authorization_code, refresh_token' });
		}
	}

	/**
	 * Validates an Authorization header against issued access tokens.
	 */
	validateBearer(authorizationHeader: string | undefined): 'ok' | 'missing' | 'invalid' {
		if (!authorizationHeader?.toLowerCase().startsWith('bearer ')) return 'missing';
		const token = authorizationHeader.slice(7).trim();
		if (!token) return 'missing';

		const record = this.db.getOAuthToken(hashToken(token));
		if (!record || record.token_type !== 'access' || record.expires_at < Date.now()) return 'invalid';
		return 'ok';
	}

	/**
	 * Resolves and authenticates the client for a token request.
	 * Sends the error response itself and returns null on failure.
	 */
	private authenticateClient(req: Request, res: Response): string | null {
		const body = (req.body ?? {}) as Record<string, unknown>;
		let clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
		let clientSecret = typeof body.client_secret === 'string' ? body.client_secret : undefined;

		const authHeader = req.headers.authorization;
		if (authHeader?.startsWith('Basic ')) {
			const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
			const separator = decoded.indexOf(':');
			if (separator > 0) {
				clientId = decodeURIComponent(decoded.slice(0, separator));
				clientSecret = decodeURIComponent(decoded.slice(separator + 1));
			}
		}

		if (!clientId) {
			res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
			return null;
		}

		const client = this.db.getOAuthClient(clientId);
		if (!client) {
			res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client' });
			return null;
		}

		if (client.tokenEndpointAuthMethod !== 'none') {
			if (!clientSecret || !client.clientSecret || hashToken(clientSecret) !== hashToken(client.clientSecret)) {
				res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed' });
				return null;
			}
		}

		return clientId;
	}

	private handleAuthorizationCodeGrant(clientId: string, body: Record<string, unknown>, res: Response): void {
		const code = typeof body.code === 'string' ? body.code : undefined;
		if (!code) {
			res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
			return;
		}

		const issued = this.codes.get(code);
		if (issued) this.codes.delete(code);

		if (!issued || Date.now() - issued.createdAt > AUTH_CODE_TTL_MS || issued.clientId !== clientId) {
			res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired' });
			return;
		}

		const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
		if (redirectUri && redirectUri !== issued.redirectUri) {
			res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request' });
			return;
		}

		if (issued.codeChallenge) {
			const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : undefined;
			if (!codeVerifier || !verifyPkce(codeVerifier, issued.codeChallenge)) {
				res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
				return;
			}
		}

		res.json(this.issueTokens(clientId, issued.scope));
	}

	private handleRefreshTokenGrant(clientId: string, body: Record<string, unknown>, res: Response): void {
		const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : undefined;
		if (!refreshToken) {
			res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
			return;
		}

		const tokenHash = hashToken(refreshToken);
		const record = this.db.getOAuthToken(tokenHash);

		if (!record || record.token_type !== 'refresh' || record.expires_at < Date.now() || record.client_id !== clientId) {
			res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired' });
			return;
		}

		this.db.deleteOAuthToken(tokenHash);
		const scope = typeof body.scope === 'string' && body.scope ? body.scope : DEFAULT_SCOPE;
		res.json(this.issueTokens(clientId, scope));
	}

	private issueTokens(clientId: string, scope: string): Record<string, unknown> {
		const accessToken = generateSecret('mca');
		const refreshToken = generateSecret('mcr');
		const now = Date.now();

		this.db.saveOAuthToken(hashToken(accessToken), 'access', clientId, now + ACCESS_TOKEN_TTL_MS);
		this.db.saveOAuthToken(hashToken(refreshToken), 'refresh', clientId, now + REFRESH_TOKEN_TTL_MS);

		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
			refresh_token: refreshToken,
			scope,
		};
	}
}
