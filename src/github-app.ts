import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  private: boolean;
  default_branch: string;
  clone_url: string;
}

export class GitHubAppAuth {
  private config: GitHubAppConfig | null = null;
  private cachedToken: InstallationToken | null = null;
  private readonly tokenExpiryBuffer = 5 * 60 * 1000;

  constructor() {
    const appId = process.env.GITHUB_APP_ID;
    const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
    const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

    if (appId && installationId && privateKeyPath) {
      this.config = { appId, installationId, privateKeyPath };
    }
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  private createJWT(): string {
    if (!this.config) throw new Error('GitHub App not configured');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60,
      exp: now + 10 * 60,
      iss: this.config.appId,
    };

    const privateKey = readFileSync(this.config.privateKeyPath, 'utf-8');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsignedToken = `${header}.${body}`;

    const sign = createSign('RSA-SHA256');
    sign.update(unsignedToken);
    sign.end();
    const signature = sign.sign(privateKey, 'base64url');

    return `${unsignedToken}.${signature}`;
  }

  private async fetchInstallationToken(): Promise<InstallationToken> {
    if (!this.config) throw new Error('GitHub App not configured');

    const jwt = this.createJWT();
    const response = await fetch(
      `https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { token: string; expires_at: string };
    return {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    };
  }

  async getInstallationToken(): Promise<string> {
    if (!this.config) throw new Error('GitHub App not configured');

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + this.tokenExpiryBuffer) {
      return this.cachedToken.token;
    }

    this.cachedToken = await this.fetchInstallationToken();
    return this.cachedToken.token;
  }

  async listRepositories(options: {
    page?: number;
    perPage?: number;
    search?: string;
  } = {}): Promise<{ repositories: GitHubRepository[]; totalCount: number }> {
    if (!this.config) throw new Error('GitHub App not configured');

    const token = await this.getInstallationToken();
    const page = options.page ?? 1;
    const perPage = Math.min(options.perPage ?? 30, 100);

    const url = new URL(`https://api.github.com/installation/repositories`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error('GitHub App authentication expired');
      if (response.status === 403) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0') throw new Error('GitHub API rate limit exceeded');
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { repositories: GitHubRepository[]; total_count: number };

    let repositories = data.repositories;
    if (options.search) {
      const query = options.search.toLowerCase();
      repositories = repositories.filter((repo) =>
        repo.full_name.toLowerCase().includes(query) ||
        repo.name.toLowerCase().includes(query)
      );
    }

    return {
      repositories,
      totalCount: options.search ? repositories.length : data.total_count,
    };
  }

  async verifyRepositoryAccess(owner: string, repo: string): Promise<boolean> {
    if (!this.config) throw new Error('GitHub App not configured');

    const token = await this.getInstallationToken();
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    return response.ok;
  }
}
