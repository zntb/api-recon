import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  buildCompletionSpec,
  completionScript,
  isCompletionShell,
} from '../../src/cli/completion.js';

/** A stand-in with the shapes the real CLI uses: a subcommand, choices, files. */
function sampleProgram(): Command {
  const program = new Command();
  program
    .name('sample')
    .option('-d, --depth <n>', 'crawl depth')
    .option('-b, --browser <engine>', 'engine to drive')
    .option('-a, --auth <file>', 'saved session')
    .option('-o, --out <dir>', 'output directory')
    .option('--formats <list>', 'report formats')
    .option('--no-config', 'skip the config file');

  program.command('baseline <url>').description('save the baseline').option('-d, --depth <n>', 'crawl depth');
  program.command('completion <shell>').description('print a completion script');
  return program;
}

describe('isCompletionShell', () => {
  it('accepts the three shells it generates for', () => {
    expect(isCompletionShell('bash')).toBe(true);
    expect(isCompletionShell('zsh')).toBe(true);
    expect(isCompletionShell('fish')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isCompletionShell('powershell')).toBe(false);
    expect(isCompletionShell(42)).toBe(false);
    expect(isCompletionShell(undefined)).toBe(false);
  });
});

describe('buildCompletionSpec', () => {
  it('lists the subcommands and deduplicates shared flags', () => {
    const spec = buildCompletionSpec(sampleProgram());

    expect(spec.commands.map((command) => command.name)).toEqual(['baseline', 'completion']);
    // --depth is on the program and on `baseline`, but appears once.
    expect(spec.flags.filter((flag) => flag.long === '--depth')).toHaveLength(1);
    expect(spec.flags.find((flag) => flag.long === '--browser')?.takesValue).toBe(true);
    expect(spec.flags.find((flag) => flag.long === '--no-config')?.takesValue).toBe(false);
  });
});

describe('completionScript', () => {
  it('emits a bash function and registration', () => {
    const script = completionScript('bash', sampleProgram());

    expect(script).toContain('_api_recon_completions()');
    expect(script).toContain('complete -o default -F _api_recon_completions api-recon');
    expect(script).toContain('--browser) COMPREPLY=( $(compgen -W "chromium firefox webkit"');
    expect(script).toContain('--auth|--login|--actions|--config|--diff|--baseline) COMPREPLY=( $(compgen -f');
    expect(script).toContain('--out) COMPREPLY=( $(compgen -d');
    expect(script).toContain('baseline completion');
  });

  it('emits a zsh #compdef function with describe entries', () => {
    const script = completionScript('zsh', sampleProgram());

    expect(script.startsWith('#compdef api-recon')).toBe(true);
    expect(script).toContain("'--browser:engine to drive'");
    expect(script).toContain("--browser) _values 'value' chromium firefox webkit");
    expect(script).toContain('_files');
    expect(script).toContain("'baseline:save the baseline'");
  });

  it('emits fish complete lines with choices and file completion', () => {
    const script = completionScript('fish', sampleProgram());

    expect(script).toContain("complete -c api-recon -n '__fish_use_subcommand' -a baseline");
    expect(script).toContain("-l browser -s b -r -xa 'chromium firefox webkit'");
    expect(script).toContain("-l auth -s a -r -F");
    expect(script).toContain('-l no-config');
  });

  it('is deterministic, so a committed script can be diffed', () => {
    const program = sampleProgram();
    expect(completionScript('bash', program)).toBe(completionScript('bash', program));
    expect(completionScript('fish', program)).toBe(completionScript('fish', program));
  });
});
