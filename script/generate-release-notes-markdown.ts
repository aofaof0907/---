#!/usr/bin/env ts-node

import * as Fs from 'fs'
import * as Path from 'path'

function handleError(error: string) {
  console.error(error)
  process.exit(-1)
}

const args = process.argv.splice(2)

if (args.length === 0) {
  handleError(
    'You have not specified a version to generate these release notes for. Example: 2.8.1-beta2'
  )
}

const repositoryRoot = Path.dirname(__dirname)
const changelogPath = Path.join(repositoryRoot, 'changelog.json')

// eslint-disable-next-line no-sync
const changelog = Fs.readFileSync(changelogPath, 'utf8')

let changelogObj = null

try {
  changelogObj = JSON.parse(changelog)
} catch {
  handleError(
    'Unable to parse the contents of changelog.json into a JSON object. Please review the file contents.'
  )
}

const version = args[0]
const versionChanges = changelogObj.releases[version]

if (versionChanges === undefined) {
  handleError(
    'Unable to find a changelog entry for the specified version. Please review the file contents.'
  )
}

const markdownChangelogPath = Path.join(repositoryRoot, 'changelog.md')
const markdownChangelog = '- ' + versionChanges.join('\n- ') + '\n'

// eslint-disable-next-line no-sync
Fs.writeFileSync(markdownChangelogPath, markdownChangelog)
