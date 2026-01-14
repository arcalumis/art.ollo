import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export function AdminLayout() {
	const { user, logout } = useAuth();
	const location = useLocation();

	const navItems = [
		{
			path: "/admin",
			label: "Dashboard",
			icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
		},
		{
			path: "/admin/users",
			label: "Users",
			icon: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z",
		},
		{
			path: "/admin/products",
			label: "Products",
			icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10",
		},
		{
			path: "/admin/financials",
			label: "Financials",
			icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
		},
	];

	const isActive = (path: string) => {
		if (path === "/admin") return location.pathname === "/admin";
		return location.pathname.startsWith(path);
	};

	return (
		<div className="min-h-screen flex">
			{/* Sidebar */}
			<aside className="w-56 cyber-card border-r border-cyan-500/20">
				<div className="p-3 border-b border-cyan-500/20">
					<Link to="/" className="text-lg font-bold gradient-text hover:opacity-80">
						ollo.art
					</Link>
					<p className="text-[10px] text-cyan-400/50 mt-0.5">admin panel</p>
				</div>

				<nav className="p-2 space-y-0.5">
					{navItems.map((item) => (
						<Link
							key={item.path}
							to={item.path}
							className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-all ${
								isActive(item.path)
									? "bg-gradient-to-r from-pink-500/20 to-cyan-500/20 text-cyan-400 neon-border"
									: "text-gray-400 hover:bg-cyan-500/10 hover:text-cyan-400"
							}`}
						>
							<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" role="img" aria-label={item.label}>
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon} />
							</svg>
							{item.label}
						</Link>
					))}
				</nav>

				<div className="absolute bottom-0 w-56 p-2 border-t border-cyan-500/20">
					<div className="flex items-center justify-between">
						<div>
							<p className="text-xs font-medium text-white">{user?.username}</p>
							<p className="text-[10px] text-cyan-400/50">Administrator</p>
						</div>
						<button
							type="button"
							onClick={logout}
							className="p-1.5 text-gray-400 hover:text-pink-400 hover:bg-pink-500/10 rounded transition-all"
							title="Sign Out"
						>
							<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" role="img" aria-label="Sign out">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
							</svg>
						</button>
					</div>
				</div>
			</aside>

			{/* Main content */}
			<main className="flex-1 overflow-auto">
				<Outlet />
			</main>
		</div>
	);
}
