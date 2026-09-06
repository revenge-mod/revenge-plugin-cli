/**
 * Release planner
 *
 *     revenge-plugin plan-releases [--plugins-dir plugins] [--dist build/dist] [--out releases.json]
 *
 * A plugin is released when its `manifest.json` version has no matching `<name>@<version>` tag.
 * The plan is a JSON array that CI turns into tags and releases:
 *
 *     [{ "name": "...", "id": "...", "version": "...", "tag": "...", "zip": "..." }]
 *
 * Run it locally to see what a push to the release branch would publish.
 * It never writes tags, and it fails on an invalid or downgraded version.
 *
 * The planner reads Git only. It is the CI's job to take the plan and create the actual releases.
 */

import { execFileSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import {
	compareVersionsFull,
	newestVersion,
	parseVersion,
} from './generate-index.ts'

export interface PluginSource {
	/** Plugin folder name, which is also the tag prefix. */
	name: string
	id: string
	version: string
}

export interface PlannedRelease extends PluginSource {
	tag: string
	zip: string
}

/** Decides which plugins to release. */
export function planReleases(
	plugins: PluginSource[],
	releasedVersions: (name: string) => string[],
	distDir = 'build/dist',
): PlannedRelease[] {
	const plan: PlannedRelease[] = []

	for (const plugin of [...plugins].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const { name, id, version } = plugin

		try {
			parseVersion(version)
		} catch {
			throw new Error(`${name}: invalid version '${version}'`)
		}

		const released = releasedVersions(name)
		if (released.includes(version)) {
			console.log(`= ${name}@${version} already released`)
			continue
		}

		// The manifest must not go below the newest released version. The total
		// order decides, so promoting `1.2.0-rc` to `1.2.0` is an upgrade.
		const newest = newestVersion(released)
		if (
			newest &&
			compareVersionsFull(parseVersion(version), parseVersion(newest)) < 0
		)
			throw new Error(
				`${name}: manifest version ${version} is below released ${newest}`,
			)

		plan.push({
			name,
			id,
			version,
			tag: `${name}@${version}`,
			zip: `${distDir}/${id}.zip`,
		})
	}

	return plan
}

/** Reads `<pluginsDir>/<name>/manifest.json` for every plugin. */
export function readPluginSources(pluginsDir = 'plugins'): PluginSource[] {
	if (!existsSync(pluginsDir))
		throw new Error(`No plugins directory at '${pluginsDir}'`)

	const sources: PluginSource[] = []
	for (const name of readdirSync(pluginsDir)) {
		const manifestPath = `${pluginsDir}/${name}/manifest.json`
		if (!existsSync(manifestPath)) continue

		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
			id?: string
			version?: string
		}
		if (!manifest.id || !manifest.version)
			throw new Error(`${name}: manifest.json needs both 'id' and 'version'`)

		sources.push({ name, id: manifest.id, version: manifest.version })
	}
	return sources
}

/** Groups `git tag` output into the versions released per plugin name. */
export function readReleasedVersions(): Map<string, string[]> {
	let output: string
	try {
		output = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' })
	} catch {
		throw new Error('Cannot read git tags; is this a git repository?')
	}

	const released = new Map<string, string[]>()
	for (const tag of output.split('\n')) {
		const at = tag.indexOf('@')
		if (at <= 0) continue

		const name = tag.slice(0, at)
		const version = tag.slice(at + 1)
		// A tag can predate the current version grammar; it is history, not input.
		try {
			parseVersion(version)
		} catch {
			continue
		}

		const versions = released.get(name)
		if (versions) versions.push(version)
		else released.set(name, [version])
	}
	return released
}

export async function run(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			'plugins-dir': { type: 'string', default: 'plugins' },
			dist: { type: 'string', default: 'build/dist' },
			out: { type: 'string', default: 'releases.json' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	})
	if (values.help) {
		console.log(
			'Usage: revenge-plugin plan-releases [--plugins-dir <dir>] [--dist <dir>] [--out <file>]',
		)
		return
	}

	const released = readReleasedVersions()
	const plan = planReleases(
		readPluginSources(values['plugins-dir']),
		name => released.get(name) ?? [],
		values.dist,
	)

	for (const release of plan) console.log(`+ ${release.tag}`)

	const outDir = dirname(values.out)
	if (outDir && outDir !== '.') mkdirSync(outDir, { recursive: true })
	writeFileSync(values.out, `${JSON.stringify(plan, null, 2)}\n`)

	console.log(
		`\u2713 Wrote ${values.out}: ${plan.length} release(s) to publish`,
	)
}
