import { Wordmark } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
	ActivityIcon,
	ArrowLeftIcon,
	CpuIcon,
	CreditCardIcon,
	ImageIcon,
	LayoutDashboardIcon,
	MenuIcon,
	PackageIcon,
	ReceiptIcon,
	ScrollTextIcon,
	TagIcon,
	UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import AdminAudit from "./AdminAudit";
import AdminCreditPackages from "./AdminCreditPackages";
import AdminHealth from "./AdminHealth";
import AdminModels from "./AdminModels";
import AdminModeration from "./AdminModeration";
import AdminOverview from "./AdminOverview";
import AdminPayments from "./AdminPayments";
import AdminProducts from "./AdminProducts";
import AdminSubscriptions from "./AdminSubscriptions";
import AdminUserDetail from "./AdminUserDetail";
import AdminUsers from "./AdminUsers";

const NAV = [
	{ to: "/admin", label: "Overview", icon: LayoutDashboardIcon, end: true },
	{ to: "/admin/subscriptions", label: "Subscriptions", icon: CreditCardIcon },
	{ to: "/admin/users", label: "Users", icon: UsersIcon },
	{ to: "/admin/payments", label: "Payments", icon: ReceiptIcon },
	{ to: "/admin/models", label: "Models", icon: CpuIcon },
	{ to: "/admin/health", label: "Health", icon: ActivityIcon },
	{ to: "/admin/moderation", label: "Moderation", icon: ImageIcon },
	{ to: "/admin/audit", label: "Audit log", icon: ScrollTextIcon },
	{ to: "/admin/products", label: "Plans", icon: TagIcon },
	{ to: "/admin/credit-packages", label: "Credit packs", icon: PackageIcon },
];

function Brand() {
	return (
		<div className="flex items-center gap-2">
			<Wordmark className="text-xl" />
			<span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
				Admin
			</span>
		</div>
	);
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
	return (
		<nav aria-label="Admin" className="flex flex-col gap-0.5">
			{NAV.map((item) => (
				<NavLink
					key={item.to}
					to={item.to}
					end={item.end}
					onClick={onNavigate}
					className={({ isActive }) =>
						cn(
							"flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
							isActive && "bg-muted font-medium text-foreground",
						)
					}
				>
					<item.icon className="size-4" aria-hidden />
					{item.label}
				</NavLink>
			))}
		</nav>
	);
}

function Footer() {
	const { user } = useAuth();
	return (
		<div className="flex flex-col gap-2 border-t border-border pt-3">
			<Link
				to="/create"
				className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				<ArrowLeftIcon className="size-4" aria-hidden />
				Back to ollo
			</Link>
			<p className="truncate px-3 text-xs text-muted-foreground">Signed in as {user?.username}</p>
		</div>
	);
}

export default function AdminApp() {
	const [menuOpen, setMenuOpen] = useState(false);
	const location = useLocation();

	// Each admin view starts at the top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation
	useEffect(() => {
		window.scrollTo(0, 0);
	}, [location.pathname]);

	return (
		<div className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
			{/* Desktop sidebar */}
			<div className="hidden border-r border-border bg-card lg:block">
				<aside className="sticky top-0 flex h-dvh flex-col gap-6 px-3 py-5">
					<div className="px-2">
						<Brand />
					</div>
					<div className="flex-1 overflow-y-auto">
						<NavList />
					</div>
					<Footer />
				</aside>
			</div>

			{/* Phone bar */}
			<header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
				<Brand />
				<Button
					variant="ghost"
					size="icon"
					aria-label="Open admin menu"
					onClick={() => setMenuOpen(true)}
				>
					<MenuIcon />
				</Button>
			</header>
			<Sheet open={menuOpen} onOpenChange={setMenuOpen}>
				<SheetContent side="left" className="w-72 gap-6 px-3 py-5">
					<SheetTitle className="px-2">
						<Brand />
					</SheetTitle>
					<div className="flex-1 overflow-y-auto">
						<NavList onNavigate={() => setMenuOpen(false)} />
					</div>
					<Footer />
				</SheetContent>
			</Sheet>

			<main className="mx-auto w-full max-w-7xl min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
				<Routes>
					<Route index element={<AdminOverview />} />
					<Route path="subscriptions" element={<AdminSubscriptions />} />
					<Route path="users" element={<AdminUsers />} />
					<Route path="users/:id" element={<AdminUserDetail />} />
					<Route path="payments" element={<AdminPayments />} />
					<Route path="models" element={<AdminModels />} />
					<Route path="health" element={<AdminHealth />} />
					<Route path="moderation" element={<AdminModeration />} />
					<Route path="audit" element={<AdminAudit />} />
					<Route path="products" element={<AdminProducts />} />
					<Route path="credit-packages" element={<AdminCreditPackages />} />
					{/* Old financial pages moved to the overview. */}
					<Route path="financials/*" element={<Navigate to="/admin" replace />} />
					<Route path="*" element={<Navigate to="/admin" replace />} />
				</Routes>
			</main>
		</div>
	);
}
