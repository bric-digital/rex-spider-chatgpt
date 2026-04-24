#!/usr/bin/env node

/**
 * Build script to bundle test-target modules for browser testing.
 * Uses esbuild to create browser-compatible bundles.
 */

import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const browserInput = join(__dirname, '../../src/browser.mts')
const browserOutput = join(__dirname, '../src/build/browser.bundle.js')

const crawlTargetInput = join(__dirname, '../../src/crawl-target.mts')
const crawlTargetOutput = join(__dirname, '../src/build/crawl-target.bundle.js')

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2021',
  sourcemap: true
}

try {
  await esbuild.build({ ...shared, entryPoints: [browserInput], outfile: browserOutput })
  await esbuild.build({ ...shared, entryPoints: [crawlTargetInput], outfile: crawlTargetOutput })
  console.log('Bundles created:')
  console.log(' ', browserOutput)
  console.log(' ', crawlTargetOutput)
} catch (error) {
  console.error('Build failed:', error)
  process.exit(1)
}
