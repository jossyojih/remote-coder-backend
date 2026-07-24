import { runCommand } from './agent-runtime.js';
import type { Repository } from './types.js';

export interface ValidationCommand {
  command: string;
  args: string[];
  description: string;
}

export interface ValidationResult {
  repositoryId: string;
  repositoryName: string;
  passed: boolean;
  results: Array<{
    command: string;
    description: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
  }>;
}

export interface RepositoryValidationConfig {
  enabled: boolean;
  commands: ValidationCommand[];
}

export function getDefaultValidationCommands(repository: Repository): ValidationCommand[] {
  const commands: ValidationCommand[] = [];

  commands.push({
    command: 'npm',
    args: ['run', 'test'],
    description: 'Run test suite',
  });

  commands.push({
    command: 'npm',
    args: ['run', 'build'],
    description: 'Build project',
  });

  return commands;
}

export async function validateRepository(
  repository: Repository,
  worktreePath: string,
  config: RepositoryValidationConfig
): Promise<ValidationResult> {
  const commands = config.enabled ? config.commands : [];
  const results: ValidationResult['results'] = [];
  let allPassed = true;

  for (const { command, args, description } of commands) {
    try {
      const { stdout, stderr } = await runCommand(command, args, worktreePath);
      results.push({
        command: `${command} ${args.join(' ')}`,
        description,
        exitCode: 0,
        stdout: stdout.slice(0, 4096),
        stderr: stderr.slice(0, 4096),
        passed: true,
      });
    } catch (error) {
      allPassed = false;
      const exitCode = error instanceof Error && /failed \((\d+)\)/.test(error.message)
        ? Number(error.message.match(/failed \((\d+)\)/)?.[1] ?? 1)
        : 1;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        command: `${command} ${args.join(' ')}`,
        description,
        exitCode,
        stdout: '',
        stderr: message.slice(0, 4096),
        passed: false,
      });
    }
  }

  return {
    repositoryId: repository.id,
    repositoryName: repository.name,
    passed: allPassed,
    results,
  };
}

export async function validateRepositories(
  repositories: Repository[],
  runs: Array<{ repositoryId: string; worktreePath: string }>,
  config: Map<string, RepositoryValidationConfig>
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const run of runs) {
    const repository = repositories.find((r) => r.id === run.repositoryId);
    if (!repository) continue;

    const validationConfig = config.get(run.repositoryId) ?? { enabled: false, commands: [] };
    const result = await validateRepository(repository, run.worktreePath, validationConfig);
    results.push(result);
  }

  return results;
}
