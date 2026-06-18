import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { IconPlus } from "../components/Icons";
import { Modal } from "../components/Modal";
import { useAuth } from "../contexts/AuthContext";
import { useAdminCreditPackages } from "../hooks/useAdmin";
import type { CreditPackage } from "../types";

interface PackageFormData {
	name: string;
	credits: string;
	priceSol: string;
	priceCents: string;
	stripePriceId: string;
	availableForUsd: boolean;
	availableForSol: boolean;
	isActive: boolean;
}

const emptyForm: PackageFormData = {
	name: "",
	credits: "",
	priceSol: "",
	priceCents: "",
	stripePriceId: "",
	availableForUsd: false,
	availableForSol: true,
	isActive: true,
};

export default function AdminCreditPackages() {
	const { token } = useAuth();
	const { packages, loading, fetchPackages, createPackage, updatePackage, deletePackage } =
		useAdminCreditPackages(token);
	const [showForm, setShowForm] = useState(false);
	const [editingPackage, setEditingPackage] = useState<CreditPackage | null>(null);
	const [formData, setFormData] = useState<PackageFormData>(emptyForm);

	useEffect(() => {
		fetchPackages();
	}, [fetchPackages]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!formData.name || !formData.credits || !formData.priceSol) return;

		const packageData = {
			name: formData.name,
			credits: Number.parseInt(formData.credits, 10),
			priceSol: Number.parseFloat(formData.priceSol),
			priceCents: formData.priceCents ? Number.parseInt(formData.priceCents, 10) : null,
			stripePriceId: formData.stripePriceId || null,
			availableForUsd: formData.availableForUsd,
			availableForSol: formData.availableForSol,
			isActive: formData.isActive,
		};

		if (editingPackage) {
			const success = await updatePackage(editingPackage.id, packageData);
			if (success) {
				setShowForm(false);
				setEditingPackage(null);
				setFormData(emptyForm);
				fetchPackages();
			}
		} else {
			const result = await createPackage(packageData);
			if (result) {
				setShowForm(false);
				setFormData(emptyForm);
				fetchPackages();
			}
		}
	};

	const handleEdit = (pkg: CreditPackage) => {
		setEditingPackage(pkg);
		setFormData({
			name: pkg.name,
			credits: pkg.credits.toString(),
			priceSol: pkg.priceSol.toString(),
			priceCents: pkg.priceCents?.toString() || "",
			stripePriceId: pkg.stripePriceId || "",
			availableForUsd: pkg.availableForUsd,
			availableForSol: pkg.availableForSol,
			isActive: pkg.isActive,
		});
		setShowForm(true);
	};

	const handleDelete = async (pkg: CreditPackage) => {
		if (!confirm(`Are you sure you want to deactivate "${pkg.name}"?`)) return;
		const success = await deletePackage(pkg.id);
		if (success) {
			fetchPackages();
		}
	};

	const handleToggleActive = async (pkg: CreditPackage) => {
		const success = await updatePackage(pkg.id, { isActive: !pkg.isActive });
		if (success) {
			fetchPackages();
		}
	};

	const formatCreditsPerSol = (credits: number, priceSol: number) => {
		return (credits / priceSol).toFixed(0);
	};

	return (
		<div className="p-4">
			<div className="flex items-center justify-between mb-4">
				<div>
					<h1 className="text-xl font-bold gradient-text">Credit Packages</h1>
					<p className="text-xs text-gray-400 mt-1">
						Manage credit packages for SOL and USD purchase
					</p>
				</div>
				<Button
					variant="primary"
					onClick={() => {
						setEditingPackage(null);
						setFormData(emptyForm);
						setShowForm(true);
					}}
					className="flex items-center gap-1"
				>
					<IconPlus className="w-4 h-4" />
					New Package
				</Button>
			</div>

			{/* Packages grid */}
			{loading && packages.length === 0 ? (
				<div className="text-gray-400 text-sm">Loading...</div>
			) : packages.length === 0 ? (
				<div className="text-center py-8 text-gray-400">
					<p className="text-sm">No credit packages yet.</p>
					<p className="text-xs mt-1">Create your first SOL credit package.</p>
				</div>
			) : (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
					{packages.map((pkg) => (
						<div
							key={pkg.id}
							className={`cyber-card rounded p-4 ${!pkg.isActive ? "opacity-50" : ""}`}
						>
							<div className="flex items-start justify-between mb-3">
								<div>
									<h3 className="text-base font-semibold">{pkg.name}</h3>
									<div className="flex gap-1 mt-0.5">
										{!pkg.isActive && <span className="text-[10px] text-red-400">Inactive</span>}
										{pkg.availableForSol && <span className="text-[10px] px-1 bg-purple-500/20 text-purple-400 rounded">SOL</span>}
										{pkg.availableForUsd && <span className="text-[10px] px-1 bg-green-500/20 text-green-400 rounded">USD</span>}
									</div>
								</div>
								<div className="text-right">
									<div className="text-xl font-bold text-purple-400">
										{pkg.priceSol} SOL
									</div>
									{pkg.priceCents != null && pkg.priceCents > 0 && (
										<div className="text-sm font-bold text-green-400">${(pkg.priceCents / 100).toFixed(2)}</div>
									)}
									<div className="text-xs text-gray-500">
										{pkg.credits} credits
									</div>
								</div>
							</div>

							<div className="space-y-1 mb-3 text-xs">
								<div className="flex justify-between">
									<span className="text-gray-500">Credits per SOL</span>
									<span className="text-cyan-400">
										{formatCreditsPerSol(pkg.credits, pkg.priceSol)}
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-gray-500">Cost per credit</span>
									<span className="text-cyan-400">
										{(pkg.priceSol / pkg.credits).toFixed(4)} SOL
									</span>
								</div>
								{pkg.stripePriceId && (
									<div className="flex justify-between">
										<span className="text-gray-500">Stripe Price</span>
										<span className="text-green-400 font-mono text-[10px] truncate max-w-[120px]" title={pkg.stripePriceId}>
											{pkg.stripePriceId}
										</span>
									</div>
								)}
							</div>

							<div className="flex gap-1.5 pt-2 border-t border-cyan-500/20">
								<button
									type="button"
									onClick={() => handleEdit(pkg)}
									className="flex-1 px-2 py-1 cyber-card hover:neon-border rounded text-xs transition-all"
								>
									Edit
								</button>
								<button
									type="button"
									onClick={() => handleToggleActive(pkg)}
									className={`flex-1 px-2 py-1 rounded text-xs transition-colors ${
										pkg.isActive
											? "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
											: "bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30"
									}`}
								>
									{pkg.isActive ? "Disable" : "Enable"}
								</button>
								{!pkg.isActive && (
									<button
										type="button"
										onClick={() => handleDelete(pkg)}
										className="px-2 py-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded text-xs transition-colors"
									>
										Delete
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			)}

			{/* Package form modal */}
			<Modal
				isOpen={showForm}
				onClose={() => {
					setShowForm(false);
					setEditingPackage(null);
				}}
				title={editingPackage ? "Edit Credit Package" : "New Credit Package"}
				size="sm"
			>
				<form onSubmit={handleSubmit} className="space-y-3">
					<div>
						<label
							htmlFor="package-name"
							className="block text-xs font-medium text-gray-400 mb-1"
						>
							Name *
						</label>
						<input
							id="package-name"
							type="text"
							value={formData.name}
							onChange={(e) => setFormData({ ...formData, name: e.target.value })}
							placeholder="e.g., Starter, Pro"
							className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							required
						/>
					</div>

					<div className="grid grid-cols-3 gap-2">
						<div>
							<label
								htmlFor="package-credits"
								className="block text-xs font-medium text-gray-400 mb-1"
							>
								Credits *
							</label>
							<input
								id="package-credits"
								type="number"
								value={formData.credits}
								onChange={(e) =>
									setFormData({ ...formData, credits: e.target.value })
								}
								placeholder="e.g., 100"
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
								required
								min="1"
							/>
						</div>
						<div>
							<label
								htmlFor="package-price-sol"
								className="block text-xs font-medium text-gray-400 mb-1"
							>
								Price (SOL) *
							</label>
							<input
								id="package-price-sol"
								type="number"
								step="0.001"
								value={formData.priceSol}
								onChange={(e) =>
									setFormData({ ...formData, priceSol: e.target.value })
								}
								placeholder="e.g., 0.1"
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
								required
								min="0.001"
							/>
						</div>
						<div>
							<label
								htmlFor="package-price-cents"
								className="block text-xs font-medium text-gray-400 mb-1"
							>
								Price (cents)
							</label>
							<input
								id="package-price-cents"
								type="number"
								value={formData.priceCents}
								onChange={(e) =>
									setFormData({ ...formData, priceCents: e.target.value })
								}
								placeholder="e.g., 999"
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
								min="1"
							/>
						</div>
					</div>

					<div>
						<label
							htmlFor="package-stripe-price-id"
							className="block text-xs font-medium text-gray-400 mb-1"
						>
							Stripe Price ID
						</label>
						<input
							id="package-stripe-price-id"
							type="text"
							value={formData.stripePriceId}
							onChange={(e) =>
								setFormData({ ...formData, stripePriceId: e.target.value })
							}
							placeholder="price_..."
							className="cyber-input w-full px-2 py-1.5 rounded text-sm font-mono"
						/>
						<p className="text-[10px] text-gray-500 mt-0.5">Required for USD purchases via Stripe</p>
					</div>

					{formData.credits && formData.priceSol && (
						<div className="p-2 bg-purple-500/10 rounded text-xs text-purple-300">
							SOL rate:{" "}
							{formatCreditsPerSol(
								Number.parseInt(formData.credits, 10),
								Number.parseFloat(formData.priceSol),
							)}{" "}
							credits per SOL
							{formData.priceCents && (
								<span className="text-green-300 ml-2">
									| USD: ${(Number.parseInt(formData.priceCents, 10) / 100).toFixed(2)}
								</span>
							)}
						</div>
					)}

					{/* Availability toggles */}
					<div className="flex gap-4 p-2 cyber-card rounded">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={formData.availableForSol}
								onChange={(e) =>
									setFormData({ ...formData, availableForSol: e.target.checked })
								}
								className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500"
							/>
							<span className="text-xs text-gray-300">Available for SOL</span>
						</label>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={formData.availableForUsd}
								onChange={(e) =>
									setFormData({ ...formData, availableForUsd: e.target.checked })
								}
								className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-green-500"
							/>
							<span className="text-xs text-gray-300">Available for USD</span>
						</label>
					</div>

					<label className="flex items-center gap-2 cursor-pointer p-2 cyber-card rounded">
						<input
							type="checkbox"
							checked={formData.isActive}
							onChange={(e) =>
								setFormData({ ...formData, isActive: e.target.checked })
							}
							className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-cyan-500"
						/>
						<span className="text-xs text-gray-300">
							Active (available for purchase)
						</span>
					</label>

					<div className="flex gap-2 pt-2">
						<Button
							variant="secondary"
							onClick={() => {
								setShowForm(false);
								setEditingPackage(null);
							}}
							className="flex-1"
						>
							Cancel
						</Button>
						<Button variant="primary" type="submit" className="flex-1">
							{editingPackage ? "Save" : "Create"}
						</Button>
					</div>
				</form>
			</Modal>
		</div>
	);
}
