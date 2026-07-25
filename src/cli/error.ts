import type { Entry } from "../index.js";

/** an error that results from invalid command line usage */
export class UsageError extends Error {
  /** the command that was being invoked, if it could be determined */
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.command = command;
  }
}

/** an error that results from a target that doesn't exist on reMarkable */
export class TargetNotFoundError extends Error {
  /** the target that couldn't be found */
  readonly target: string;

  constructor(target: string) {
    super(`couldn't find '${target}' on reMarkable`);
    this.target = target;
  }
}

/** an error that results from a target that matches more than one entry */
export class AmbiguousTargetError extends Error {
  /** the target that matched several entries */
  readonly target: string;
  /** every entry that matched the target */
  readonly matches: readonly Entry[];

  constructor(target: string, matches: readonly Entry[]) {
    super(`'${target}' matched ${matches.length} entries on reMarkable`);
    this.target = target;
    this.matches = matches;
  }
}

/** an error that results from missing or rejected credentials */
export class AuthError extends Error {}
