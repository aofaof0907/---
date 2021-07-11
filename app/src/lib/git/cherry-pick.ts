import * as Path from 'path'
import * as FSE from 'fs-extra'
import { GitError } from 'dugite'
import { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { git, IGitExecutionOptions, IGitResult } from './core'
import { getStatus } from './status'
import { stageFiles } from './update-index'
import { ICherryPickProgress } from '../../models/progress'
import { getCommitsInRange, revRangeInclusive } from './rev-list'
import { CommitOneLine } from '../../models/commit'
import { merge } from '../merge'
import { ChildProcess } from 'child_process'
import { round } from '../../ui/lib/round'
import byline from 'byline'
import { ICherryPickSnapshot } from '../../models/cherry-pick'

/** The app-specific results from attempting to cherry pick commits*/
export enum CherryPickResult {
  /**
   * Git completed the cherry pick without reporting any errors, and the caller can
   * signal success to the user.
   */
  CompletedWithoutError = 'CompletedWithoutError',
  /**
   * The cherry pick encountered conflicts while attempting to cherry pick and
   * need to be resolved before the user can continue.
   */
  ConflictsEncountered = 'ConflictsEncountered',
  /**
   * The cherry pick was not able to continue as tracked files were not staged in
   * the index.
   */
  OutstandingFilesNotStaged = 'OutstandingFilesNotStaged',
  /**
   * The cherry pick was not attempted because it could not check the status of
   * the repository. The caller needs to confirm the repository is in a usable
   * state.
   */
  Aborted = 'Aborted',
  /**
   * An unexpected error as part of the cherry pick flow was caught and handled.
   *
   * Check the logs to find the relevant Git details.
   */
  Error = 'Error',
}

/**
 * A parser to read and emit cherry pick progress from Git `stdout`.
 *
 * Each successful cherry picked commit outputs a set of lines similar to the
 * following example:
 *    [branchName commitSha] commitSummary
 *      Date: timestamp
 *      1 file changed, 1 insertion(+)
 *      create mode 100644 filename
 */
class GitCherryPickParser {
  private count = 0
  public constructor(private readonly commits: ReadonlyArray<CommitOneLine>) {}

  public parse(line: string): ICherryPickProgress | null {
    const cherryPickRe = /^\[(.*\s.*)\]/
    const match = cherryPickRe.exec(line)
    if (match === null) {
      // Skip lines that don't represent the first line of a successfully picked
      // commit. -- i.e. timestamp, files changed, conflicts, etc..
      return null
    }
    this.count++

    return {
      kind: 'cherryPick',
      title: `Cherry picking commit ${this.count} of ${this.commits.length} commits`,
      value: round(this.count / this.commits.length, 2),
      cherryPickCommitCount: this.count,
      totalCommitCount: this.commits.length,
      currentCommitSummary: this.commits[this.count - 1]?.summary ?? '',
    }
  }
}

/**
 * This method merges `baseOptions` with a call back method that obtains a
 * `ICherryPickProgress` instance from `stdout` parsing.
 *
 * @param baseOptions - contains git execution options other than the
 * progressCallBack such as expectedErrors
 * @param commits - used by the parser to form `ICherryPickProgress` instance
 * @param progressCallback - the callback method that accepts an
 * `ICherryPickProgress` instance created by the parser
 */
function configureOptionsWithCallBack(
  baseOptions: IGitExecutionOptions,
  commits: readonly CommitOneLine[],
  progressCallback: (progress: ICherryPickProgress) => void
) {
  return merge(baseOptions, {
    processCallback: (process: ChildProcess) => {
      if (process.stdout === null) {
        return
      }
      const parser = new GitCherryPickParser(commits)

      byline(process.stdout).on('data', (line: string) => {
        const progress = parser.parse(line)

        if (progress != null) {
          progressCallback(progress)
        }
      })
    },
  })
}

/**
 * A stub function to initiate cherry picking in the app.
 *
 * @param revisionRange - this could be a single commit sha or could be a range
 * of commits like sha1..sha2 or inclusively sha1^..sha2
 */
export async function cherryPick(
  repository: Repository,
  revisionRange: string,
  progressCallback?: (progress: ICherryPickProgress) => void
): Promise<CherryPickResult> {
  let baseOptions: IGitExecutionOptions = {
    expectedErrors: new Set([GitError.MergeConflicts]),
  }

  if (progressCallback !== undefined) {
    // If it is a single commit sha, format it as tho it is a range
    // so getCommitsInRange only pulls back single commit.
    if (revisionRange.includes('..') === false) {
      revisionRange = revRangeInclusive(revisionRange, revisionRange)
    }

    const commits = await getCommitsInRange(repository, revisionRange)

    if (commits === null) {
      // BadRevision can be raised here if git rev-list is unable to resolve a
      // revision range, so we need to signal to the caller that this cherry
      // pick is not possible to perform
      log.warn(
        `Unable to cherry pick these branches
        because one or both of the refs do not exist in the repository`
      )
      return CherryPickResult.Error
    }

    baseOptions = await configureOptionsWithCallBack(
      baseOptions,
      commits,
      progressCallback
    )
  }

  const result = await git(
    ['cherry-pick', revisionRange],
    repository.path,
    'cherry pick',
    baseOptions
  )

  return parseCherryPickResult(result)
}

/**
 * Method to determine if cherry pick will result in conflicts
 *
 * @param revisionRange - this could be a single commit sha or could be a range
 * of commits like sha1..sha2 or inclusively sha1^..sha2
 */
export async function willCherryPickHaveConflicts(
  repository: Repository,
  revisionRange: string
): Promise<Boolean> {
  const baseOptions: IGitExecutionOptions = {
    expectedErrors: new Set([GitError.MergeConflicts]),
  }

  // `--no-commit flag` will just attempt to complete the cherry pick but will not
  // commit anything
  const result = await git(
    ['cherry-pick', revisionRange, '--no-commit'],
    repository.path,
    'cherry pick',
    baseOptions
  )

  const hasConflicts =
    parseCherryPickResult(result) === CherryPickResult.ConflictsEncountered

  const cherryPickHead = readCherryPickHead(repository)
  if (cherryPickHead === null) {
    abortCherryPick(repository)
  }

  return hasConflicts
}

function parseCherryPickResult(result: IGitResult): CherryPickResult {
  if (result.exitCode === 0) {
    return CherryPickResult.CompletedWithoutError
  }

  switch (result.gitError) {
    case GitError.MergeConflicts:
      return CherryPickResult.ConflictsEncountered
    case GitError.UnresolvedConflicts:
      return CherryPickResult.OutstandingFilesNotStaged
    default:
      throw new Error(`Unhandled result found: '${JSON.stringify(result)}'`)
  }
}

/**
 * Inspect the `.git/sequencer` folder and convert the current cherry pick
 * state into am `ICherryPickProgress` instance as well as return an array of
 * remaining commits queued for cherry picking.
 *  - Progress instance required to display progress to user.
 *  - Commits required to track progress after a conflict has been resolved.
 *
 * This is required when Desktop is not responsible for initiating the cherry
 * pick and when continuing a cherry pick after conflicts are resolved:
 *
 * It returns null if it cannot parse an ongoing cherry pick. This happens when,
 *  - There isn't a cherry pick in progress (expected null outcome).
 *  - Runs into errors parsing cherry pick files. This is expected if cherry
 *    pick is aborted or finished during parsing. It could also occur if cherry
 *    pick sequencer files are corrupted.
 */
export async function getCherryPickSnapshot(
  repository: Repository
): Promise<ICherryPickSnapshot | null> {
  const cherryPickHead = readCherryPickHead(repository)
  if (cherryPickHead === null) {
    // If there no cherry pick head, there is no cherry pick in progress.
    return null
  }

  let firstSha: string = ''
  let lastSha: string = ''
  const remainingShas: string[] = []
  // Try block included as files may throw an error if it cannot locate
  // the sequencer files. This is possible if cherry pick is continued
  // or aborted at the same time.
  try {
    // This contains the sha of the first committed pick.
    firstSha = (
      await FSE.readFile(
        Path.join(repository.path, '.git', 'sequencer', 'abort-safety'),
        'utf8'
      )
    ).trim()

    if (firstSha === '') {
      // Technically possible if someone continued or aborted the cherry pick at
      // the same time
      return null
    }

    // This contains a reference to the remaining commits to cherry pick.
    const remainingPicks = (
      await FSE.readFile(
        Path.join(repository.path, '.git', 'sequencer', 'todo'),
        'utf8'
      )
    ).trim()

    if (remainingPicks === '') {
      // Technically possible if someone continued or aborted the cherry pick at
      // the same time
      return null
    }

    // Each line is of the format: `pick shortSha commitSummary`
    remainingPicks.split('\n').forEach(line => {
      const linePieces = line.split(' ')
      if (linePieces.length > 2) {
        remainingShas.push(linePieces[1])
      }
    })

    if (remainingShas.length === 0) {
      // This should only be possible with corrupt sequencer files.
      return null
    }
    lastSha = remainingShas[remainingShas.length - 1]

    if (lastSha === '') {
      // This should only be possible with corrupt sequencer files.
      return null
    }
  } catch {}

  const commits = await getCommitsInRange(
    repository,
    revRangeInclusive(firstSha, lastSha)
  )

  if (commits === null || commits.length === 0) {
    // This should only be possible with corrupt sequencer files resulting in a
    // bad revision range.
    return null
  }

  const count = commits.length - remainingShas.length
  return {
    progress: {
      kind: 'cherryPick',
      title: `Cherry picking commit ${count} of ${commits.length} commits`,
      value: round(count / commits.length, 2),
      cherryPickCommitCount: count,
      totalCommitCount: commits.length,
      currentCommitSummary: commits[count - 1].summary ?? '',
    },
    remainingCommits: commits.slice(count, commits.length),
  }
}

/**
 * Proceed with the current cherry pick operation and report back on whether it completed
 *
 * It is expected that the index has staged files which are cleanly cherry
 * picked onto the base branch, and the remaining unstaged files are those which
 * need manual resolution or were changed by the user to address inline
 * conflicts.
 *
 * @param files - The working directory of files. These are the files that are
 * detected to have changes that we want to stage for the cherry pick.
 */
export async function continueCherryPick(
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>,
  progressCallback?: (progress: ICherryPickProgress) => void
): Promise<CherryPickResult> {
  // only stage files related to cherry pick
  const trackedFiles = files.filter(f => {
    return f.status.kind !== AppFileStatusKind.Untracked
  })
  await stageFiles(repository, trackedFiles)

  const status = await getStatus(repository)
  if (status == null) {
    log.warn(
      `[continueCherryPick] unable to get status after staging changes,
        skipping any other steps`
    )
    return CherryPickResult.Aborted
  }

  // make sure cherry pick is still in progress to continue
  const cherryPickCurrentCommit = await readCherryPickHead(repository)
  if (cherryPickCurrentCommit === null) {
    return CherryPickResult.Aborted
  }

  let options: IGitExecutionOptions = {
    expectedErrors: new Set([
      GitError.MergeConflicts,
      GitError.UnresolvedConflicts,
    ]),
    env: {
      // if we don't provide editor, we can't detect git errors
      GIT_EDITOR: ':',
    },
  }

  if (progressCallback !== undefined) {
    const snapshot = await getCherryPickSnapshot(repository)
    if (snapshot === null) {
      log.warn(
        `[continueCherryPick] unable to get cherry pick status, skipping other steps`
      )
      return CherryPickResult.Aborted
    }
    options = configureOptionsWithCallBack(
      options,
      snapshot.remainingCommits,
      progressCallback
    )
  }

  const result = await git(
    ['cherry-pick', '--continue'],
    repository.path,
    'continueCherryPick',
    options
  )

  return parseCherryPickResult(result)
}

/** Abandon the current cherry pick operation */
export async function abortCherryPick(repository: Repository) {
  await git(['cherry-pick', '--abort'], repository.path, 'abortCherryPick')
}

/**
 * Attempt to read the `.git/CHERRY_PICK_HEAD` file inside a repository to confirm
 * the cherry pick is still active.
 */
async function readCherryPickHead(
  repository: Repository
): Promise<string | null> {
  try {
    const cherryPickHead = Path.join(
      repository.path,
      '.git',
      'CHERRY_PICK_HEAD'
    )
    const cherryPickCurrentCommitOutput = await FSE.readFile(
      cherryPickHead,
      'utf8'
    )
    return cherryPickCurrentCommitOutput.trim()
  } catch (err) {
    log.warn(
      `[cherryPick] a problem was encountered reading .git/CHERRY_PICK_HEAD,
       so it is unsafe to continue cherry picking`,
      err
    )
    return null
  }
}
