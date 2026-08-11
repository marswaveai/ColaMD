import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dir_project = process.cwd()
const path_base = path.join(dir_project, 'src/renderer/themes/base.css')
const path_premium = path.join(dir_project, 'src/renderer/themes/premium.css')
const dir_themes = path.join(dir_project, 'themes')

const text_base = fs.readFileSync(path_base, 'utf8')
const text_built_in = [
	text_base,
	fs.readFileSync(path_premium, 'utf8')
].join('\n')

const values_secondary = {
	light: '#656d76',
	dark: '#aab3bd',
	elegant: '#6c6c6c',
	sepia: '#7b6b54',
	notion: '#777674',
	bear: '#767676',
	writer: '#757571',
	'solarized-dark': '#a4bbc3',
	nord: '#aebdd4',
	gruvbox: '#c5b5a5',
	dracula: '#afb7db',
	midnight: '#b1b1b1'
}

const values_link = {
	elegant: '#bc4424',
	sepia: '#9c5e29',
	'solarized-dark': '#3093da'
}

function getVariables(text_block) {
	const values_token = {}
	const pattern_token = /--([a-z-]+):\s*([^;]+);/g

	for (const match_token of text_block.matchAll(pattern_token)) {
		values_token[match_token[1]] = match_token[2].trim().toLowerCase()
	}

	return values_token
}

function getBuiltInTheme(name_theme) {
	const pattern_theme = new RegExp(
		`body(?:,\\s*body)?\\.theme-${name_theme}\\s*\\{([^}]+)\\}`
	)
	const match_theme = text_built_in.match(pattern_theme)
	assert.ok(match_theme, `Missing built-in theme: ${name_theme}`)
	return getVariables(match_theme[1])
}

function getStandaloneTheme(name_theme) {
	const path_theme = path.join(dir_themes, `${name_theme}.css`)
	const text_theme = fs.readFileSync(path_theme, 'utf8')
	const match_root = text_theme.match(/:root\s*\{([^}]+)\}/)
	assert.ok(match_root, `Missing :root block: ${name_theme}.css`)
	return getVariables(match_root[1])
}

function getRelativeLuminance(value_hex) {
	const values_rgb = value_hex.slice(1).match(/.{2}/g)
	assert.ok(values_rgb, `Invalid hex color: ${value_hex}`)
	const values_linear = values_rgb.map((value_channel) => {
		const value_srgb = Number.parseInt(value_channel, 16) / 255
		return value_srgb <= 0.04045
			? value_srgb / 12.92
			: ((value_srgb + 0.055) / 1.055) ** 2.4
	})

	return 0.2126 * values_linear[0]
		+ 0.7152 * values_linear[1]
		+ 0.0722 * values_linear[2]
}

function blendColors(value_foreground, value_background, opacity_foreground) {
	const values_foreground = value_foreground.slice(1).match(/.{2}/g)
	const values_background = value_background.slice(1).match(/.{2}/g)
	assert.ok(values_foreground, `Invalid hex color: ${value_foreground}`)
	assert.ok(values_background, `Invalid hex color: ${value_background}`)
	const values_blended = values_foreground.map((value_channel, index_channel) => {
		const channel_foreground = Number.parseInt(value_channel, 16)
		const channel_background = Number.parseInt(values_background[index_channel], 16)
		return Math.round(
			channel_foreground * opacity_foreground
			+ channel_background * (1 - opacity_foreground)
		)
	})

	return `#${values_blended
		.map((value_channel) => value_channel.toString(16).padStart(2, '0'))
		.join('')}`
}

function getContrastRatio(value_foreground, value_background) {
	const luminance_foreground = getRelativeLuminance(value_foreground)
	const luminance_background = getRelativeLuminance(value_background)
	const luminance_light = Math.max(luminance_foreground, luminance_background)
	const luminance_dark = Math.min(luminance_foreground, luminance_background)
	return (luminance_light + 0.05) / (luminance_dark + 0.05)
}

for (const [name_theme, value_secondary] of Object.entries(values_secondary)) {
	const values_built_in = getBuiltInTheme(name_theme)
	const values_standalone = getStandaloneTheme(name_theme)

	assert.equal(values_built_in['text-secondary'], value_secondary)
	assert.equal(values_standalone['text-secondary'], value_secondary)
	assert.ok(
		getContrastRatio(value_secondary, values_built_in['bg-color']) >= 4.5,
		`${name_theme} secondary text must meet WCAG AA`
	)

	for (const opacity_match of [0.18, 0.32]) {
		const value_match = blendColors(
			values_built_in['link-color'],
			values_built_in['bg-color'],
			opacity_match
		)
		assert.ok(
			getContrastRatio(values_built_in['text-color'], value_match) >= 4.5,
			`${name_theme} search match at ${opacity_match} must meet WCAG AA`
		)
	}
}

for (const [name_theme, value_link] of Object.entries(values_link)) {
	const values_built_in = getBuiltInTheme(name_theme)
	const values_standalone = getStandaloneTheme(name_theme)

	assert.equal(values_built_in['link-color'], value_link)
	assert.equal(values_standalone['link-color'], value_link)
	assert.ok(
		getContrastRatio(value_link, values_built_in['bg-color']) >= 4.5,
		`${name_theme} link must meet WCAG AA`
	)
}

const values_solarized = getBuiltInTheme('solarized-dark')
assert.equal(values_solarized['text-color'], '#c2d5d7')
assert.ok(
	getContrastRatio(values_solarized['text-color'], values_solarized['bg-color']) >= 7,
	'Solarized Dark body text must meet WCAG AAA'
)

assert.match(
	text_base,
	/--search-match-bg:\s*color-mix\(in srgb, var\(--link-color\) 18%, transparent\);/
)
assert.match(
	text_base,
	/--search-match-current-bg:\s*color-mix\(in srgb, var\(--link-color\) 32%, transparent\);/
)
assert.match(text_base, /body:not\(\.theme-custom\), body\.theme-light\s*\{/)
assert.doesNotMatch(text_base, /body, body\.theme-light\s*\{/)
assert.match(text_base, /\.search-match\s*\{[^}]*background: var\(--search-match-bg\);/s)
assert.match(
	text_base,
	/\.search-match-current\s*\{[^}]*background: var\(--search-match-current-bg\);/s
)

console.log('Theme color contract passed for 12 built-in and standalone themes.')
