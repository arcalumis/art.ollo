interface UsageFrequencyBarProps {
	data: { date: string; imageCount: number }[];
	className?: string;
}

export function UsageFrequencyBar({ data, className = "" }: UsageFrequencyBarProps) {
	if (!data || data.length === 0) return null;

	// Find max for scaling
	const maxCount = Math.max(...data.map((d) => d.imageCount), 1);

	// Color intensity based on count relative to max
	const getColor = (count: number) => {
		if (count === 0) return "bg-stone-2";
		const intensity = count / maxCount;
		if (intensity < 0.25) return "bg-verdigris/30";
		if (intensity < 0.5) return "bg-verdigris/55";
		if (intensity < 0.75) return "bg-verdigris/80";
		return "bg-verdigris";
	};

	const totalImages = data.reduce((sum, d) => sum + d.imageCount, 0);

	return (
		<div
			className={`flex items-center gap-0.5 ${className}`}
			title={`${totalImages} images in last 30 days`}
		>
			{data.map((day) => (
				<div
					key={day.date}
					className={`w-1.5 h-3 rounded-sm ${getColor(day.imageCount)}`}
					title={`${day.date}: ${day.imageCount} images`}
				/>
			))}
		</div>
	);
}
