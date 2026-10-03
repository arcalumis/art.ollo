import { MoonIcon, MonitorIcon, SunIcon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Finish, useTheme } from "@/contexts/ThemeContext";

const OPTIONS: { value: Finish; label: string }[] = [
	{ value: "system", label: "Match system" },
	{ value: "night", label: "Night" },
	{ value: "plaster", label: "Plaster" },
];

/** Appearance menu: Night, Plaster, or follow the system setting. */
export function ThemeSwitcher(_props: { compact?: boolean }) {
	const { finish, resolved, setFinish } = useTheme();
	const Icon = finish === "system" ? MonitorIcon : resolved === "night" ? MoonIcon : SunIcon;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
				aria-label="Appearance"
			>
				<Icon className="size-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-40">
				<DropdownMenuRadioGroup value={finish} onValueChange={(value) => setFinish(value as Finish)}>
					{OPTIONS.map((option) => (
						<DropdownMenuRadioItem key={option.value} value={option.value}>
							{option.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
