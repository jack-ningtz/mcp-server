/* ============================================================
 * 今日待办 — OAuth 2.1 Authorization Server Provider
 *
 * 基于 MCP SDK 的 OAuthProvider 接口实现。生产要点：
 * - 客户端注册、授权码、token 均做持久化（JSON 文件），重启不丢
 * - 支持 PKCE、RFC 8707 resource 校验、token introspection
 * - 每个 OAuth client（即一个 WorkBuddy 用户会话）映射一个用户 id，
 *   待办数据按该 id 隔离（见 store.js）
 *
 * 注意：授权端点 /authorize 需要一个"用户确认页"。本实现提供一个
 * 简洁的自动授权页（demo 用途）；生产可将 authorize() 改为接入
 * WorkBuddy 账号 SSO 后再签发 code。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { resourceUrlFromServerUrl } = require('@modelcontextprotocol/sdk/shared/auth-utils.js');
const { InvalidRequestError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const STATE_FILE = process.env.OAUTH_STATE_FILE || path.join(__dirname, '.oauth-state.json');
const TOKEN_TTL = 7 * 24 * 3600; // 7 天

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      clients: s.clients || {},
      codes: s.codes || {},
      tokens: s.tokens || {},
      refresh: s.refresh || {},
    };
  } catch (e) {
    return { clients: {}, codes: {}, tokens: {}, refresh: {} };
  }
}

function persist(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/** 客户端注册表（支持动态注册 DCR） */
class PersistentClientsStore {
  constructor(state) { this.state = state; }
  async getClient(clientId) { return this.state.clients[clientId] || undefined; }
  async registerClient(metadata) {
    const client = {
      ...metadata,
      client_id: metadata.client_id || crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.state.clients[client.client_id] = client;
    persist(this.state);
    return client;
  }
}

class PersistentAuthProvider {
  constructor({ mcpServerUrl, strictResource = false }) {
    this.state = loadState();
    this.clientsStore = new PersistentClientsStore(this.state);
    this.mcpServerUrl = mcpServerUrl;
    this.strictResource = strictResource;
  }

  async authorize(client, params, res) {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError('Unregistered redirect_uri');
    }
    if (this.strictResource && params.resource) {
      const expected = resourceUrlFromServerUrl(this.mcpServerUrl);
      if (params.resource.toString() !== expected.toString()) {
        throw new InvalidRequestError('Invalid resource');
      }
    }
    // 用户身份：优先从已登录 cookie 取，否则用一个稳定标识（生产应接 WorkBuddy SSO）
    let userId = 'user_demo';
    const cookie = (res.req && res.req.headers.cookie) || '';
    const m = cookie.match(/(?:^|;\s*)wb_user=([^;]+)/);
    if (m) userId = decodeURIComponent(m[1]);

    const code = crypto.randomUUID();
    this.state.codes[code] = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes || [],
      resource: params.resource ? params.resource.toString() : undefined,
      userId,
      expiresAt: Date.now() + 10 * 60 * 1000, // code 10 分钟
    };
    persist(this.state);

    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    res.redirect(target.toString());
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const c = this.state.codes[authorizationCode];
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
      throw new Error('Invalid or expired authorization code');
    }
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri, resource) {
    const c = this.state.codes[code];
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
      throw new Error('Invalid or expired authorization code');
    }
    if (redirectUri && c.redirectUri !== redirectUri) {
      throw new Error('redirect_uri mismatch');
    }
    delete this.state.codes[code];

    const accessToken = crypto.randomUUID().replace(/-/g, '');
    const refreshToken = crypto.randomUUID().replace(/-/g, '');
    const scope = (c.scopes || []).join(' ');
    this.state.tokens[accessToken] = {
      clientId: client.client_id,
      userId: c.userId,
      scopes: c.scopes || [],
      resource: c.resource || (resource ? resource.toString() : this.mcpServerUrl),
      expiresAt: Date.now() + TOKEN_TTL * 1000,
    };
    this.state.refresh[refreshToken] = {
      clientId: client.client_id,
      userId: c.userId,
      scopes: c.scopes || [],
      resource: c.resource,
    };
    persist(this.state);
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL,
      refresh_token: refreshToken,
      scope,
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const r = this.state.refresh[refreshToken];
    if (!r || r.clientId !== client.client_id) throw new Error('Invalid refresh token');
    const accessToken = crypto.randomUUID().replace(/-/g, '');
    this.state.tokens[accessToken] = {
      clientId: client.client_id,
      userId: r.userId,
      scopes: scopes && scopes.length ? scopes : r.scopes,
      resource: r.resource || (resource ? resource.toString() : this.mcpServerUrl),
      expiresAt: Date.now() + TOKEN_TTL * 1000,
    };
    persist(this.state);
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL,
      scope: (scopes && scopes.length ? scopes : r.scopes).join(' '),
    };
  }

  async verifyAccessToken(token) {
    const t = this.state.tokens[token];
    if (!t || t.expiresAt < Date.now()) throw new Error('Invalid or expired token');
    return {
      token,
      clientId: t.clientId,
      userId: t.userId,
      scopes: t.scopes,
      expiresAt: Math.floor(t.expiresAt / 1000),
      resource: t.resource ? new URL(t.resource) : undefined,
      // 自定义字段透传给工具层做用户隔离
      extra: { userId: t.userId },
    };
  }

  async revokeToken(client, token) {
    delete this.state.tokens[token];
    delete this.state.refresh[token];
    persist(this.state);
  }

  /** introspection 端点用：返回 token 元信息 */
  async introspect(token) {
    try {
      const info = await this.verifyAccessToken(token);
      return {
        active: true,
        client_id: info.clientId,
        user_id: info.userId,
        scope: (info.scopes || []).join(' '),
        exp: info.expiresAt,
        aud: info.resource ? info.resource.toString() : this.mcpServerUrl,
      };
    } catch (e) {
      return { active: false };
    }
  }
}

module.exports = { PersistentAuthProvider };
