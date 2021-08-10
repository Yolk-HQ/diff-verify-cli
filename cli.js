#!/usr/bin/env node

import chalk from 'chalk';
import { createTwoFilesPatch, diffLines } from 'diff';
import execa from 'execa';
import fs from 'fs';
import { globby } from 'globby';
import isPathCwd from 'is-path-cwd';
import isPathInside from 'is-path-inside';
import meow from 'meow';
import moveFile from 'move-file';
import pathExists from 'path-exists';

const copyFile = fs.promises.copyFile;
const readFile = fs.promises.readFile;

const cli = meow(
  `
  Verify that a command generates files which match existing files on disk.
  Files matching the path/glob specified by '-p' will be copied with a '.tmp' suffix, then the
  command will be executed, and newly-generated files will be compared with the existing '.tmp'
  files. If a diff is found, then diff-verify will exit with a status code of 1.
  
  Usage
    $ diff-verify -p <path|glob> [--dry-run] -- <command> [...args]

  Options
    --dry-run   Skip copying, emitting, diffing, and deleting files on disk. Only log operations
                which would be done.
    --path, -p  A path or glob specifying the files expected to be generated by the command.

  Examples
    $ diff-verify -p apps/bot-studio-web/graphql-types.ts -- node_modules/.bin/graphql-codegen --config apps/bot-studio-web/codegen.yml

    $ diff-verify -p apps/admin-web/locales -- pnpm run nx -- run admin-web:linguiExtract
`,
  {
    importMeta: import.meta,
    flags: {
      dryRun: {
        type: 'boolean',
      },
      path: {
        type: 'string',
        alias: 'p',
        isRequired: true,
        isMultiple: true,
      },
    },
  },
);

const log = (prefix, message) => {
  let p = '';
  switch (prefix) {
    case 'copy':
      p = chalk.blue('copy');
      break;
    case 'emit':
      p = chalk.yellow('emit');
      break;
    case 'diff':
      p = chalk.green('diff');
      break;
    case 'move':
      p = chalk.magenta('move');
      break;
    case 'error':
      p = chalk.red('error');
      break;
    default:
      p = prefix;
      break;
  }
  const out = `[${p}]`.padEnd(20) + message;
  if (prefix === 'error') {
    console.error(out);
  } else {
    console.log(out);
  }
};

const getTmpFileName = (file) => `${file}.tmp`;

(async () => {
  const emitCommand = cli.input;
  if (emitCommand.length === 0) {
    log('error', 'Missing command');
    cli.showHelp(2);
    return;
  }

  const dryRun = cli.flags.dryRun;
  const files = await globby(cli.flags.path);

  if (files.length === 0) {
    throw new Error(`No files found matching path/glob "${cli.flags.path}".`);
  }

  // Ensure files are within the current working directory, then copy each file to *.tmp
  for (const file of files) {
    const tempFile = getTmpFileName(file);
    if (isPathCwd(file)) {
      throw new Error(`"${file}": Cannot copy the current working directory.`);
    }
    if (!isPathInside(file, process.cwd())) {
      throw new Error(
        `"${file}": Cannot copy files/directories outside the current working directory.`,
      );
    }
    if (await pathExists(tempFile)) {
      throw new Error(`"${tempFile}" already exists. It must be deleted to proceed.`);
    }
  }
  for (const file of files) {
    const tempFile = getTmpFileName(file);
    log('copy', `"${file}" -> "${tempFile}"`);
    if (dryRun) continue;

    await copyFile(file, tempFile);
  }

  // Run emit command
  log('emit', emitCommand.join(' '));
  try {
    if (!dryRun) {
      await execa(emitCommand[0], emitCommand.slice(1), { stdio: 'inherit' });
    }

    // Diff each file
    let diffFound = false;
    for (const file of files) {
      const tempFile = getTmpFileName(file);
      log('diff', `"${file}" <> "${tempFile}"`);
      if (dryRun) continue;

      const fileContents = await readFile(file, { encoding: 'utf8' });
      const tempFileContents = await readFile(tempFile, { encoding: 'utf8' });
      const diff = diffLines(tempFileContents, fileContents);
      if (diff.length > 1) {
        log('error', `Found diff in "${file}".`);
        diffFound = true;
        const patch = createTwoFilesPatch(tempFile, file, tempFileContents, fileContents);
        console.log(patch);
      }
    }

    if (diffFound) {
      process.exitCode = 1;
    }
  } finally {
    // Return *.tmp files to their original location
    for (const file of files) {
      const tempFile = getTmpFileName(file);
      log('move', `"${tempFile}" -> "${file}"`);
      if (dryRun) continue;

      await moveFile(tempFile, file);
    }
  }
})();
