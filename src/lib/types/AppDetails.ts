export interface AppDetails {
	[id: string]: App
}

export interface App {
	success: boolean
	data: Data
}

export interface Data {
	type: string
	name: string
	steam_appid: number
	required_age: number
	is_free: boolean
	controller_support: string
	dlc: number[]
	detailed_description: string
	about_the_game: string
	short_description: string
	supported_languages: string
	header_image: string
	capsule_image: string
	capsule_imagev5: string
	website: string
	pc_requirements: Requirements
	mac_requirements: Requirements
	linux_requirements: Requirements
	developers: string[]
	publishers: string[]
	price_overview: PriceOverview
	packages: number[]
	package_groups: PackageGroup[]
	platforms: Platforms
	categories: Category[]
	genres: Genre[]
	screenshots: Screenshot[]
	movies: Movie[]
	recommendations: Recommendations
	achievements: Achievements
	release_date: ReleaseDate
	support_info: SupportInfo
	background: string
	background_raw: string
	content_descriptors: ContentDescriptors
	ratings: Ratings
}

export interface Achievements {
	total: number
	highlighted: Highlighted[]
}

export interface Highlighted {
	name: string
	path: string
}

export interface Category {
	id: number
	description: string
}

export interface ContentDescriptors {
	ids: any[]
	notes: null
}

export interface Genre {
	id: string
	description: string
}

export interface Requirements {
	minimum: string
	recommended: string
}

export interface Movie {
	id: number
	name: string
	thumbnail: string
	webm: Mp4
	mp4: Mp4
	highlight: boolean
}

export interface Mp4 {
	'480': string
	max: string
}

export interface PackageGroup {
	name: string
	title: string
	description: string
	selection_text: string
	save_text: string
	display_type: number
	is_recurring_subscription: string
	subs: Sub[]
}

export interface Sub {
	packageid: number
	percent_savings_text: string
	percent_savings: number
	option_text: string
	option_description: string
	can_get_free_license: string
	is_free_license: boolean
	price_in_cents_with_discount: number
}

export interface Platforms {
	windows: boolean
	mac: boolean
	linux: boolean
}

export interface PriceOverview {
	currency: string
	initial: number
	final: number
	discount_percent: number
	initial_formatted: string
	final_formatted: string
}

export interface Ratings {
	dejus: Dejus
	steam_germany: SteamGermany
}

export interface Dejus {
	rating: string
}

export interface SteamGermany {
	rating_generated: string
	rating: string
	required_age: string
	banned: string
	use_age_gate: string
	descriptors: string
}

export interface Recommendations {
	total: number
}

export interface ReleaseDate {
	coming_soon: boolean
	date: string
}

export interface Screenshot {
	id: number
	path_thumbnail: string
	path_full: string
}

export interface SupportInfo {
	url: string
	email: string
}
