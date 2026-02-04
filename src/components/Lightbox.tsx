import { useEffect, useState, useRef } from "react";
import { IconClose, IconDownload, IconRotate } from "./Icons";

interface LightboxProps {
	imageUrl: string;
	alt?: string;
	onClose: () => void;
	rotation?: number;
}

export function Lightbox({ imageUrl, alt = "Image", onClose, rotation: initialRotation = 0 }: LightboxProps) {
	const [localRotation, setLocalRotation] = useState(initialRotation);
	const [position, setPosition] = useState({ x: 0, y: 0 });
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
	const hasDragged = useRef(false);

	const handleRotate = () => {
		setLocalRotation((prev) => (prev + 90) % 360);
	};

	// Mouse drag handlers
	const handleMouseDown = (e: React.MouseEvent) => {
		e.preventDefault();
		setIsDragging(true);
		hasDragged.current = false;
		setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
	};

	const handleMouseMove = (e: React.MouseEvent) => {
		if (!isDragging) return;
		const newX = e.clientX - dragStart.x;
		const newY = e.clientY - dragStart.y;
		if (Math.abs(newX - position.x) > 3 || Math.abs(newY - position.y) > 3) {
			hasDragged.current = true;
		}
		setPosition({ x: newX, y: newY });
	};

	const handleMouseUp = () => {
		setIsDragging(false);
	};

	// Touch drag handlers for mobile
	const handleTouchStart = (e: React.TouchEvent) => {
		const touch = e.touches[0];
		setIsDragging(true);
		hasDragged.current = false;
		setDragStart({ x: touch.clientX - position.x, y: touch.clientY - position.y });
	};

	const handleTouchMove = (e: React.TouchEvent) => {
		if (!isDragging) return;
		const touch = e.touches[0];
		const newX = touch.clientX - dragStart.x;
		const newY = touch.clientY - dragStart.y;
		if (Math.abs(newX - position.x) > 3 || Math.abs(newY - position.y) > 3) {
			hasDragged.current = true;
		}
		setPosition({ x: newX, y: newY });
	};

	const handleTouchEnd = () => {
		setIsDragging(false);
	};

	// Handle background click - only close if not dragged
	const handleBackgroundClick = () => {
		if (!hasDragged.current) {
			onClose();
		}
	};

	// Close on escape key, rotate on R key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "r" || e.key === "R") {
				handleRotate();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	// Prevent body scroll when lightbox is open
	useEffect(() => {
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = "";
		};
	}, []);

	return (
		<div
			className="fixed inset-0 z-50 bg-black/95 overflow-hidden"
			onClick={handleBackgroundClick}
		>
			{/* Image container */}
			<div className="w-full h-full flex items-center justify-center">
				<img
					src={imageUrl}
					alt={alt}
					className="max-w-none select-none"
					style={{
						transform: `translate(${position.x}px, ${position.y}px) scale(2) rotate(${localRotation}deg)`,
						cursor: isDragging ? 'grabbing' : 'grab',
						transformOrigin: 'center center',
					}}
					draggable={false}
					onMouseDown={handleMouseDown}
					onMouseMove={handleMouseMove}
					onMouseUp={handleMouseUp}
					onMouseLeave={handleMouseUp}
					onTouchStart={handleTouchStart}
					onTouchMove={handleTouchMove}
					onTouchEnd={handleTouchEnd}
					onClick={(e) => e.stopPropagation()}
				/>
			</div>

			{/* Bottom center toolbar */}
			<div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex gap-2 z-[60]">
				{/* Rotate button */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						handleRotate();
					}}
					className="p-2 bg-black/50 rounded-full text-white/70 hover:text-white hover:bg-black/70 transition-colors"
					title="Rotate (R)"
				>
					<IconRotate className="w-6 h-6" />
				</button>

				{/* Download button */}
				<a
					href={imageUrl}
					download
					onClick={(e) => e.stopPropagation()}
					className="p-2 bg-black/50 rounded-full text-white/70 hover:text-white hover:bg-black/70 transition-colors"
					title="Download"
				>
					<IconDownload className="w-6 h-6" />
				</a>

				{/* Close button */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onClose();
					}}
					className="p-2 bg-black/50 rounded-full text-white/70 hover:text-white hover:bg-black/70 transition-colors"
					title="Close (Esc)"
				>
					<IconClose className="w-6 h-6" />
				</button>
			</div>
		</div>
	);
}
