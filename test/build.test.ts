import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import modules from '@revenge-mod/types/modules.json' with { type: 'json' }
import { parseSync } from '@swc/core'

const GlobalAliases: Record<string, string> = {
	react: 'revenge.react.React',
	'react-native': 'revenge.react.ReactNative',
	'react/jsx-runtime': 'revenge.react.ReactJSXRuntime',
	'react/jsx-dev-runtime': 'revenge.react.ReactJSXRuntime',
	'@shopify/flash-list': 'revenge.externals.Shopify.FlashList',
}

const HostRuntimeNamespaces = new Set(modules.map(mod => mod.split('/')[0]!))

function isExternal(id: string): boolean {
	if (id in GlobalAliases) return true
	if (id === '@revenge-mod') return true
	if (id.startsWith('@revenge-mod/')) {
		const subPath = id.slice('@revenge-mod/'.length)
		const firstSegment = subPath.split('/')[0]!
		return HostRuntimeNamespaces.has(firstSegment)
	}
	return false
}

function toPascalCase(str: string): string {
	return str
		.split(/[-_]/)
		.filter(Boolean)
		.map(seg => seg.charAt(0).toUpperCase() + seg.slice(1))
		.join('')
}

function toCamelCase(str: string): string {
	return str.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function toGlobalPath(id: string): string {
	if (id in GlobalAliases) return GlobalAliases[id]!

	if (id === '@revenge-mod' || id.startsWith('@revenge-mod/')) {
		const path = id.slice('@revenge-mod'.length).replace(/^\//, '')
		const parts = path ? path.split('/') : []
		const segments: string[] = []

		let isExternals = false
		for (const part of parts) {
			if (part === 'externals') {
				isExternals = true
				segments.push('externals')
			} else if (isExternals) {
				segments.push(toPascalCase(part))
			} else {
				segments.push(toCamelCase(part))
			}
		}
		return ['revenge', ...segments].join('.')
	}

	throw new Error(`Cannot map import to a Revenge global: ${id}`)
}

function extractSymbols(code: string) {
	const ast = parseSync(code, { syntax: 'typescript', tsx: true })
	const symbolMap = new Map<string, string>()

	for (const node of ast.body) {
		if (node.type !== 'ImportDeclaration') continue
		const source = node.source.value
		if (!isExternal(source) || source.startsWith('react/jsx')) continue
		const globalPath = toGlobalPath(source)

		for (const spec of node.specifiers || []) {
			if (
				spec.type === 'ImportDefaultSpecifier' ||
				spec.type === 'ImportNamespaceSpecifier'
			) {
				symbolMap.set(spec.local.value, globalPath)
			} else if (spec.type === 'ImportSpecifier') {
				const imported = spec.imported ? spec.imported.value : spec.local.value
				symbolMap.set(spec.local.value, `${globalPath}.${imported}`)
			}
		}
	}

	let expanded = true
	while (expanded) {
		expanded = false
		for (const node of ast.body) {
			if (node.type !== 'VariableDeclaration') continue

			for (const decl of node.declarations) {
				if (!decl.init) continue

				let baseTarget: string | null = null
				if (decl.init.type === 'Identifier' && symbolMap.has(decl.init.value)) {
					baseTarget = symbolMap.get(decl.init.value)!
				} else if (
					decl.init.type === 'MemberExpression' &&
					decl.init.object.type === 'Identifier' &&
					decl.init.property.type === 'Identifier' &&
					symbolMap.has(decl.init.object.value)
				) {
					const baseObj = symbolMap.get(decl.init.object.value)!
					const propName = decl.init.property.value
					baseTarget = `${baseObj}.${propName}`
				}

				if (!baseTarget) continue

				if (decl.id.type === 'ObjectPattern') {
					for (const prop of decl.id.properties) {
						if (prop.type === 'AssignmentPatternProperty') {
							const name = prop.key.value
							if (!symbolMap.has(name)) {
								symbolMap.set(name, `${baseTarget}.${name}`)
								expanded = true
							}
						} else if (
							prop.type === 'KeyValuePatternProperty' &&
							prop.key.type === 'Identifier' &&
							prop.value.type === 'Identifier'
						) {
							const key = prop.key.value
							const value = prop.value.value
							if (!symbolMap.has(value)) {
								symbolMap.set(value, `${baseTarget}.${key}`)
								expanded = true
							}
						}
					}
				} else if (decl.id.type === 'Identifier') {
					const name = decl.id.value
					if (!symbolMap.has(name)) {
						symbolMap.set(name, baseTarget)
						expanded = true
					}
				}
			}
		}
	}

	return symbolMap
}

describe('CLI Build Global Mapping & AST Transformer', () => {
	test('maps core imports to exact Revenge global paths', () => {
		expect(toGlobalPath('react')).toBe('revenge.react.React')
		expect(toGlobalPath('react-native')).toBe('revenge.react.ReactNative')
		expect(toGlobalPath('@shopify/flash-list')).toBe(
			'revenge.externals.Shopify.FlashList',
		)
		expect(toGlobalPath('@revenge-mod/discord/design')).toBe(
			'revenge.discord.design',
		)
		expect(toGlobalPath('@revenge-mod/components/Page')).toBe(
			'revenge.components.Page',
		)
		expect(toGlobalPath('@revenge-mod/externals/react-native-clipboard')).toBe(
			'revenge.externals.ReactNativeClipboard',
		)
	})

	test('extracts imported symbols cleanly to exact direct property access paths', () => {
		const sampleCode = `
import { onSettingsModulesLoaded, refreshSettings } from '@revenge-mod/discord/modules/settings'
import { Design } from '@revenge-mod/discord/design'
import { FlashList } from '@shopify/flash-list'
import { SettingListRenderer } from '@revenge-mod/discord/modules/settings/renderer'
`
		const symbols = extractSymbols(sampleCode)
		expect(symbols.get('refreshSettings')).toBe(
			'revenge.discord.modules.settings.refreshSettings',
		)
		expect(symbols.get('onSettingsModulesLoaded')).toBe(
			'revenge.discord.modules.settings.onSettingsModulesLoaded',
		)
		expect(symbols.get('Design')).toBe('revenge.discord.design.Design')
		expect(symbols.get('FlashList')).toBe(
			'revenge.externals.Shopify.FlashList.FlashList',
		)
		expect(symbols.get('SettingListRenderer')).toBe(
			'revenge.discord.modules.settings.renderer.SettingListRenderer',
		)
	})

	test('inlines destructured symbols from imported objects and erases destructuring statements', () => {
		const sampleCode = `
import { Design } from '@revenge-mod/discord/design'

const {
	Stack,
	Text,
} = Design

function SettingsComponent() {
	return <Text />
}
`
		const symbols = extractSymbols(sampleCode)
		expect(symbols.get('Design')).toBe('revenge.discord.design.Design')
		expect(symbols.get('Stack')).toBe('revenge.discord.design.Design.Stack')
		expect(symbols.get('Text')).toBe('revenge.discord.design.Design.Text')
	})

	test('validates all monorepo plugins compile cleanly in production without standalone read statements', () => {
		const plugins = readdirSync('../plugins')
		let pluginCount = 0

		for (const name of plugins) {
			const dir = `../plugins/${name}`
			if (!existsSync(`${dir}/manifest.json`)) continue
			pluginCount++
			const buildJsPath = `${dir}/build/js/index.js`
			expect(existsSync(buildJsPath)).toBe(true)

			const code = readFileSync(buildJsPath, 'utf8')
			// Must be a bare expression starting with (function
			expect(code.trimStart().startsWith('(function')).toBe(true)
			// Must not contain invalid function call on module object revenge.discord.modules.settings()
			expect(/revenge\.discord\.modules\.settings\(\)/.test(code)).toBe(false)
			// Must not contain standalone external property read statements
			expect(/e\.discord\.design\.Design;/.test(code)).toBe(false)
			expect(/revenge\.discord\.design\.Design;/.test(code)).toBe(false)
		}

		expect(pluginCount).toBeGreaterThanOrEqual(10)
	})
})
