import { useMemo, useState } from "react";
import type { Thread } from "../types";
import { IconChat, IconGrid, IconSettings } from "./Icons";

interface SidebarProps {
	threads: Thread[];
	selectedThreadId?: string;
	onSelectThread: (thread: Thread) => void;
	onNewThread: () => void;
	onRenameThread?: (threadId: string, newTitle: string) => void;
	onDeleteThread?: (thread: Thread) => void;
	onViewGallery: () => void;
	viewMode: "chat" | "gallery" | "billing";
	onViewModeChange: (mode: "chat" | "gallery" | "billing") => void;
	onOpenSettings: () => void;
	onLogout: () => void;
	username: string;
	isAdmin?: boolean;
	collapsed?: boolean;
	onToggleCollapse?: () => void;
}

function formatDateGroup(date: Date): string {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	const weekAgo = new Date(today);
	weekAgo.setDate(weekAgo.getDate() - 7);

	const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

	if (itemDate.getTime() === today.getTime()) return "Today";
	if (itemDate.getTime() === yesterday.getTime()) return "Yesterday";
	if (itemDate >= weekAgo) return "This Week";
	return "Older";
}

interface GroupedThreads {
	[key: string]: Thread[];
}

export function Sidebar({
	threads,
	selectedThreadId,
	onSelectThread,
	onNewThread,
	onRenameThread,
	onDeleteThread,
	onViewGallery,
	viewMode,
	onViewModeChange,
	onOpenSettings,
	onLogout,
	username,
	isAdmin,
	collapsed = false,
	onToggleCollapse,
}: SidebarProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState("");
	const [contextMenuThread, setContextMenuThread] = useState<string | null>(null);
	const [manageMode, setManageMode] = useState(false);

	// Filter and group threads by date
	const { filteredThreads, groupedThreads } = useMemo(() => {
		const filtered = searchQuery
			? threads.filter((thread) =>
					thread.title.toLowerCase().includes(searchQuery.toLowerCase()),
				)
			: threads;

		const groups: GroupedThreads = {};
		const groupOrder = ["Today", "Yesterday", "This Week", "Older"];

		for (const thread of filtered) {
			// Use lastGenerationAt or updatedAt for grouping
			const dateStr = thread.lastGenerationAt || thread.updatedAt;
			const group = formatDateGroup(new Date(dateStr));
			if (!groups[group]) groups[group] = [];
			groups[group].push(thread);
		}

		// Sort groups in order
		const sorted: GroupedThreads = {};
		for (const key of groupOrder) {
			if (groups[key]) sorted[key] = groups[key];
		}

		return { filteredThreads: filtered, groupedThreads: sorted };
	}, [threads, searchQuery]);

	const handleStartRename = (thread: Thread) => {
		setEditingThreadId(thread.id);
		setEditTitle(thread.title);
		setContextMenuThread(null);
	};

	const handleFinishRename = () => {
		if (editingThreadId && editTitle.trim() && onRenameThread) {
			onRenameThread(editingThreadId, editTitle.trim());
		}
		setEditingThreadId(null);
		setEditTitle("");
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			handleFinishRename();
		} else if (e.key === "Escape") {
			setEditingThreadId(null);
			setEditTitle("");
		}
	};

	if (collapsed) {
		return (
			<aside className="sidebar w-12 h-full flex flex-col items-center py-3 gap-3">
				<button
					type="button"
					onClick={onToggleCollapse}
					className="p-2 text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
					title="Expand sidebar"
				>
					<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
					</svg>
				</button>
				<button
					type="button"
					onClick={onNewThread}
					className="p-2 cyber-button rounded"
					title="New thread"
				>
					<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
					</svg>
				</button>
				<div className="flex-1" />
				<button
					type="button"
					onClick={onOpenSettings}
					className="p-2 text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
					title="Settings"
				>
					<IconSettings className="w-5 h-5" />
				</button>
			</aside>
		);
	}

	return (
		<aside className="sidebar w-64 h-full flex flex-col">
			{/* Header */}
			<div className="p-3 flex items-center justify-between border-b border-[var(--border)]">
				<div>
					<h1 className="text-lg font-bold gradient-text">ollo.art</h1>
					<p className="text-[9px] text-[var(--text-secondary)]">build with divine inspiration</p>
				</div>
				{onToggleCollapse && (
					<button
						type="button"
						onClick={onToggleCollapse}
						className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
						title="Collapse sidebar"
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
						</svg>
					</button>
				)}
			</div>

			{/* New Thread Button */}
			<div className="p-3">
				<button
					type="button"
					onClick={onNewThread}
					className="w-full cyber-button rounded-lg py-2.5 px-4 flex items-center justify-center gap-2"
				>
					<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
					</svg>
					<span>New Thread</span>
				</button>
			</div>

			{/* View Mode Toggle */}
			<div className="px-3 pb-2">
				<div className="flex bg-[var(--bg-tertiary)] rounded-lg p-0.5">
					<button
						type="button"
						onClick={() => onViewModeChange("chat")}
						className={`flex-1 py-1.5 px-3 rounded-md text-xs flex items-center justify-center gap-1.5 transition-all ${
							viewMode === "chat"
								? "bg-[var(--accent)] text-[var(--bg-primary)]"
								: "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
						}`}
					>
						<IconChat className="w-3.5 h-3.5" />
						<span>Chat</span>
					</button>
					<button
						type="button"
						onClick={() => {
							onViewModeChange("gallery");
							onViewGallery();
						}}
						className={`flex-1 py-1.5 px-3 rounded-md text-xs flex items-center justify-center gap-1.5 transition-all ${
							viewMode === "gallery"
								? "bg-[var(--accent)] text-[var(--bg-primary)]"
								: "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
						}`}
					>
						<IconGrid className="w-3.5 h-3.5" />
						<span>Gallery</span>
					</button>
				</div>
			</div>

			{/* Search and Manage */}
			<div className="px-3 pb-2 space-y-2">
				<div className="relative">
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search threads..."
						className="w-full cyber-input rounded-lg py-2 px-3 pl-9 text-xs"
					/>
					<svg
						className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
						/>
					</svg>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
						>
							<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					)}
				</div>
				{filteredThreads.length > 0 && (
					<button
						type="button"
						onClick={() => setManageMode(!manageMode)}
						className={`w-full py-1.5 px-3 text-xs rounded-lg transition-colors ${
							manageMode
								? "bg-[var(--accent)] text-[var(--bg-primary)] font-medium"
								: "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
						}`}
					>
						{manageMode ? "Done" : "Manage Threads"}
					</button>
				)}
			</div>

			{/* Thread List */}
			<div className="flex-1 overflow-y-auto px-2">
				{filteredThreads.length === 0 ? (
					<div className="px-3 py-6 text-center">
						<p className="text-xs text-[var(--text-secondary)]">
							{searchQuery ? "No matching threads" : "No threads yet"}
						</p>
						<p className="text-[10px] text-[var(--text-secondary)] mt-1">
							{!searchQuery && "Start a new thread to begin"}
						</p>
					</div>
				) : (
					Object.entries(groupedThreads).map(([group, groupThreads]) => (
						<div key={group}>
							<div className="date-group">{group}</div>
							{groupThreads.map((thread) => (
								<div key={thread.id} className="relative flex items-center gap-1">
									{/* Trash icon in manage mode */}
									{manageMode && onDeleteThread && (
										<button
											type="button"
											onClick={() => onDeleteThread(thread)}
											className="flex-shrink-0 p-1.5 text-[var(--accent-alt)] hover:bg-[var(--accent-alt)]/20 rounded transition-colors"
											title="Delete thread"
										>
											<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
												/>
											</svg>
										</button>
									)}
									{editingThreadId === thread.id ? (
										<input
											type="text"
											value={editTitle}
											onChange={(e) => setEditTitle(e.target.value)}
											onBlur={handleFinishRename}
											onKeyDown={handleKeyDown}
											onFocus={(e) => e.target.select()}
											className="w-full cyber-input rounded px-2 py-1.5 text-sm"
											autoFocus
										/>
									) : (
										<button
											type="button"
											onClick={() => !manageMode && onSelectThread(thread)}
											onContextMenu={(e) => {
												e.preventDefault();
												setContextMenuThread(
													contextMenuThread === thread.id ? null : thread.id,
												);
											}}
											className={`sidebar-item flex-1 text-left group ${
												selectedThreadId === thread.id ? "active" : ""
											} ${manageMode ? "cursor-default" : ""}`}
											title={thread.title}
										>
											<div className="flex items-center justify-between">
												<span className="truncate flex-1">
													{thread.title}
												</span>
												{thread.generationCount !== undefined && thread.generationCount > 0 && (
													<span className="text-[10px] text-[var(--text-secondary)] ml-2">
														{thread.generationCount}
													</span>
												)}
											</div>
										</button>
									)}

									{/* Context Menu */}
									{contextMenuThread === thread.id && (
										<>
											<div
												className="fixed inset-0 z-40"
												onClick={() => setContextMenuThread(null)}
											/>
											<div className="absolute right-0 top-full z-50 cyber-card rounded-lg shadow-lg p-1 min-w-32">
												<button
													type="button"
													onClick={() => handleStartRename(thread)}
													className="w-full px-3 py-1.5 text-xs text-left hover:bg-[var(--bg-tertiary)] rounded transition-colors"
												>
													Rename
												</button>
												{onDeleteThread && (
													<button
														type="button"
														onClick={() => {
															onDeleteThread(thread);
															setContextMenuThread(null);
														}}
														className="w-full px-3 py-1.5 text-xs text-left hover:bg-[var(--accent-alt)]/20 text-[var(--accent-alt)] rounded transition-colors"
													>
														Delete
													</button>
												)}
											</div>
										</>
									)}
								</div>
							))}
						</div>
					))
				)}
			</div>

			{/* Footer / User Menu */}
			<div className="p-3 border-t border-[var(--border)] space-y-2">
				{/* Billing Button */}
				<button
					type="button"
					onClick={() => onViewModeChange("billing")}
					className={`w-full p-2 text-xs flex items-center gap-2 cyber-card rounded transition-all ${
						viewMode === "billing" ? "neon-border bg-[var(--accent)]/10" : "hover:neon-border"
					}`}
				>
					<svg className="w-4 h-4 text-[var(--accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
					</svg>
					<span>Credits & Billing</span>
				</button>

				{/* Quick Links */}
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onOpenSettings}
						className="flex-1 p-2 text-xs flex items-center gap-2 cyber-card rounded hover:neon-border transition-all"
					>
						<IconSettings className="w-4 h-4 text-[var(--accent)]" />
						<span>Settings</span>
					</button>
					{isAdmin && (
						<a
							href="/admin"
							className="flex-1 p-2 text-xs flex items-center gap-2 cyber-card rounded hover:neon-border transition-all"
						>
							<svg className="w-4 h-4 text-[var(--accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
								/>
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
							</svg>
							<span>Admin</span>
						</a>
					)}
				</div>

				{/* User Info */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<div className="w-7 h-7 rounded-full bg-[var(--accent)] flex items-center justify-center text-[var(--bg-primary)] text-xs font-bold">
							{username.charAt(0).toUpperCase()}
						</div>
						<span className="text-xs text-[var(--text-primary)]">{username}</span>
					</div>
					<button
						type="button"
						onClick={onLogout}
						className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-alt)] transition-colors"
						title="Logout"
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
							/>
						</svg>
					</button>
				</div>
			</div>
		</aside>
	);
}
