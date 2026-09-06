import { describe, expect, test } from 'bun:test'
import {
	compareVersionsFull,
	newestVersion,
	parseVersion,
} from '../src/generate-index.ts'
import { planReleases } from '../src/plan-releases.ts'
import type { PluginSource } from '../src/plan-releases.ts'

const order = (a: string, b: string) =>
	compareVersionsFull(parseVersion(a), parseVersion(b))

describe('Version total order', () => {
	test('compares the integers first, right padding the shorter one', () => {
		expect(order('1.3.0', '1.2.9')).toBeGreaterThan(0)
		expect(order('1.2', '1.2.0')).toBe(0)
		expect(order('355.0', '356.0')).toBeLessThan(0)
	})

	test('sorts a bare version above a labeled one', () => {
		// `sort -V` disagrees, which is why the shell must not decide this.
		expect(order('1.2.0', '1.2.0-rc')).toBeGreaterThan(0)
		expect(order('1.0.0-beta', '1.0.0')).toBeLessThan(0)
	})

	test('compares label digit runs numerically', () => {
		expect(order('1.0.0-rc2', '1.0.0-rc10')).toBeLessThan(0)
		expect(order('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
		expect(order('1.0.0-rc', '1.0.0-rc1')).toBeLessThan(0)
		expect(order('1.0.0-rc3', '1.0.0-rc3')).toBe(0)
	})

	test('picks the newest of a version list', () => {
		expect(newestVersion([])).toBeNull()
		expect(newestVersion(['1.2.0-rc', '1.2.0', '1.1.9'])).toBe('1.2.0')
		expect(newestVersion(['1.2.0', '1.3.0-rc'])).toBe('1.3.0-rc')
	})
})

describe('Release planning', () => {
	const plugin = (version: string, name = 'demo'): PluginSource[] => [
		{ name, id: `com.example.${name}`, version },
	]

	test('plans a release for a version with no tag', () => {
		expect(planReleases(plugin('1.1.0'), () => ['1.0.0'])).toEqual([
			{
				name: 'demo',
				id: 'com.example.demo',
				version: '1.1.0',
				tag: 'demo@1.1.0',
				zip: 'build/dist/com.example.demo.zip',
			},
		])
	})

	test('skips a version that is already tagged', () => {
		expect(planReleases(plugin('1.0.0'), () => ['1.0.0'])).toEqual([])
	})

	test('promotes a prerelease to its stable version', () => {
		// The `sort -V` guard rejected this, blocking every rc to stable release.
		const plan = planReleases(plugin('1.2.0'), () => ['1.2.0-rc'])
		expect(plan.map(release => release.tag)).toEqual(['demo@1.2.0'])
	})

	test('rejects a version below the newest released one', () => {
		expect(() => planReleases(plugin('1.0.0'), () => ['1.1.0'])).toThrow(
			'demo: manifest version 1.0.0 is below released 1.1.0',
		)
		// A label is always a prerelease, so this goes backwards too.
		expect(() => planReleases(plugin('1.1.0-rc'), () => ['1.1.0'])).toThrow(
			'demo: manifest version 1.1.0-rc is below released 1.1.0',
		)
	})

	test('rejects a version the grammar does not allow', () => {
		expect(() => planReleases(plugin('1.0.0-RC'), () => [])).toThrow(
			"demo: invalid version '1.0.0-RC'",
		)
		expect(() => planReleases(plugin('v1.0.0'), () => [])).toThrow(
			"demo: invalid version 'v1.0.0'",
		)
	})

	test('plans every plugin in name order, against its own tags', () => {
		const released: Record<string, string[]> = {
			alpha: ['1.0.0'],
			beta: [],
		}
		const plan = planReleases(
			[...plugin('2.0.0', 'beta'), ...plugin('1.1.0', 'alpha')],
			name => released[name] ?? [],
		)
		expect(plan.map(release => release.tag)).toEqual([
			'alpha@1.1.0',
			'beta@2.0.0',
		])
	})

	test('points at the artifact the build produces', () => {
		const [release] = planReleases(plugin('1.0.0'), () => [], 'out/zips')
		expect(release?.zip).toBe('out/zips/com.example.demo.zip')
	})
})
