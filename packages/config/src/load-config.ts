import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ToolBoundaryError, type ToolDefinition } from '@tool-boundary/core';
import { rawConfigSchema, type RawConfig } from './schema.js';

export type ResolvedAuthToken = {
  readonly name: string;
  readonly tokenEnv: string;
  readonly token: string;
  readonly scopes: readonly string[];
};

export type UnresolvedAuthToken = {
  readonly name: string;
  readonly tokenEnv: string;
  readonly scopes: readonly string[];
};

export type ToolBoundaryConfig = Omit<RawConfig, 'tools'> & {
  readonly tools: Readonly<Record<string, ToolDefinition>>;
};

export type LoadedConfig = Omit<ToolBoundaryConfig, 'auth'> & {
  readonly auth: {
    readonly mode: 'static-token';
    readonly tokens: readonly ResolvedAuthToken[];
  };
  readonly configPath: string;
  readonly configDir: string;
};

export type UnresolvedLoadedConfig = Omit<ToolBoundaryConfig, 'auth'> & {
  readonly auth: {
    readonly mode: 'static-token';
    readonly tokens: readonly UnresolvedAuthToken[];
  };
  readonly configPath: string;
  readonly configDir: string;
};

export type LoadConfigOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveEnv?: boolean;
};

export async function loadConfig(configPath: string, options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const config = await loadConfigUnresolved(configPath);
  const env = options.env ?? process.env;
  const tokens = config.auth.tokens.map((token) => {
    const value = env[token.tokenEnv];
    if (value === undefined || value.length === 0) {
      throw new ToolBoundaryError('CONFIG_INVALID', `Missing static token env ${token.tokenEnv}`);
    }
    return {
      ...token,
      token: value
    };
  });
  return {
    ...config,
    auth: {
      mode: 'static-token',
      tokens
    }
  };
}

export async function loadConfigUnresolved(configPath: string): Promise<UnresolvedLoadedConfig> {
  const absolutePath = resolve(configPath);
  const content = await readFile(absolutePath, 'utf8');
  return materializeConfig(parseConfigContent(content, absolutePath), absolutePath);
}

export function parseConfigContent(content: string, source = 'tool-boundary.config.yaml'): RawConfig {
  const data = source.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
  const parsed = rawConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw new ToolBoundaryError('CONFIG_INVALID', 'Config validation failed', {
      details: parsed.error.issues
    });
  }
  return parsed.data;
}

function materializeConfig(raw: RawConfig, configPath: string): UnresolvedLoadedConfig {
  const tools = Object.fromEntries(
    Object.entries(raw.tools).map(([name, definition]) => [
      name,
      {
        ...definition,
        name
      } satisfies ToolDefinition
    ])
  );
  return {
    ...raw,
    tools,
    configPath,
    configDir: dirname(configPath)
  };
}
