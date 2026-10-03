export interface TutorialStep {
	id: number;
	title: string;
	olloMessage: string;
	description: string;
	prompt: string;
	model: string;
	aspectRatio: string;
	demoImagePath: string;
	isMultiImage?: boolean;
	multiImageNote?: string;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
	{
		id: 1,
		title: "Create a Hero",
		olloMessage:
			"Every great story begins with a hero. Let's bring Zeus to life — king of the gods, crackling with divine power. We'll use a portrait orientation to capture his commanding presence.",
		description: "Generate a character portrait using a detailed prompt and the FLUX 2 Dev model.",
		prompt:
			"Zeus, king of the Greek gods, standing on Mount Olympus with lightning crackling between his fingers. Flowing white beard, golden laurel crown, muscular build draped in royal robes. Storm clouds swirl behind him. Dramatic lighting, oil painting style, epic composition.",
		model: "black-forest-labs/flux-2-dev",
		aspectRatio: "3:4",
		demoImagePath: "/tutorial/zeus-demo.png",
	},
	{
		id: 2,
		title: "Create a Villain",
		olloMessage:
			"Now let's forge the darkness to our hero's light. Hades, lord of the underworld — wreathed in shadow and spectral flame. Same portrait orientation, so they'll match when composed together.",
		description: "Create a contrasting character using similar settings for visual consistency.",
		prompt:
			"Hades, Greek god of the underworld, seated on a throne of obsidian and bone. Pale skin, dark flowing robes with ghostly purple flames. A three-headed shadow of Cerberus looms behind him. Dark cavern lit by eerie bioluminescent crystals. Oil painting style, dramatic chiaroscuro lighting.",
		model: "black-forest-labs/flux-2-dev",
		aspectRatio: "3:4",
		demoImagePath: "/tutorial/hades-demo.png",
	},
	{
		id: 3,
		title: "Create a Crow",
		olloMessage:
			"That's me! Well, my spirit animal at least. A mystical crow — watcher between worlds, messenger of fate. We'll switch to landscape orientation for this one.",
		description: "Try a different aspect ratio for variety in your compositions.",
		prompt:
			"A mystical crow with iridescent black feathers that shimmer with deep purple and blue. Perched on an ancient stone carved with runes. One eye glows with golden fire. Misty forest background at twilight. Detailed feathers, magical atmosphere, fantasy art style, oil painting.",
		model: "black-forest-labs/flux-2-dev",
		aspectRatio: "4:3",
		demoImagePath: "/tutorial/ollo-crow-demo.png",
	},
	{
		id: 4,
		title: "Create a Battleground",
		olloMessage:
			"Now we need a stage for our epic confrontation. A cinematic widescreen scene — where heaven and hell collide. Notice how 16:9 gives us that sweeping, movie-like feel.",
		description: "Use the Cinematic aspect ratio for dramatic scene composition.",
		prompt:
			"An epic battleground where Mount Olympus meets the underworld. The left side shows golden clouds, marble columns, and rays of divine light. The right side shows dark volcanic terrain, rivers of molten lava, and spectral mist. The two realms clash in the center with a massive storm of lightning and shadow. Cinematic composition, epic fantasy art, oil painting, dramatic atmosphere.",
		model: "black-forest-labs/flux-2-dev",
		aspectRatio: "16:9",
		demoImagePath: "/tutorial/battleground-demo.png",
	},
	{
		id: 5,
		title: "Combine Them All",
		olloMessage:
			"Here's where the real magic happens! Some models can accept images as input — you can add your generated images as context, then describe how to combine them. FLUX 2 Dev and FLUX 2 Pro support image inputs (Schnell and Redux do not). Click on images in the chat to add them as inputs, then write a prompt describing the composition.",
		description:
			"Learn the multi-image workflow: add previous images as inputs and use a composition prompt. This is the most powerful feature of the platform.",
		prompt:
			"An epic mythological battle scene. Zeus stands on the left hurling lightning from the golden clouds of Olympus. Hades rises from shadow and spectral flame on the right. A mystical crow flies between them, carrying a glowing rune. The battleground stretches across the scene — divine light clashing with underworld darkness. Cinematic composition, epic oil painting, dramatic lighting, fantasy masterpiece.",
		model: "black-forest-labs/flux-2-pro",
		aspectRatio: "16:9",
		demoImagePath: "/tutorial/combined-demo.png",
		isMultiImage: true,
		multiImageNote:
			"In a real workflow, you'd click on your Zeus, Hades, Crow, and Battleground images to add them as inputs before generating. The model uses them as visual reference to create a cohesive composition.",
	},
];
