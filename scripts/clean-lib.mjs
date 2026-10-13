#!/usr/bin/env node
// Usage: node ../../scripts/clean-lib.mjs   (from a package directory, as the first step of its build)
//
// tsc and tsdown only add and overwrite files in lib/, so a module that was renamed or removed would
// leave its old output behind and get published. Start every build from an empty lib/.
import { rmSync } from 'node:fs'

rmSync('lib', { recursive: true, force: true })
