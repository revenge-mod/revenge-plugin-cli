#!/usr/bin/env node
import { existsSync } from 'node:fs'

const dist = new URL('../dist/main.js', import.meta.url)
await import(
	existsSync(dist) ? dist.href : new URL('../src/main.ts', import.meta.url).href
)
