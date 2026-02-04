import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/Button";
import { IconPlus } from "../components/Icons";
import { Modal } from "../components/Modal";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";
import { useAdminProducts } from "../hooks/useAdmin";
import type { Model, SubscriptionProduct } from "../types";

interface ProductFormData {
	name: string;
	description: string;
	monthlyImageLimit: string;
	monthlyCostLimit: string;
	dailyImageLimit: string;
	bonusCredits: string;
	price: string;
	priceSol: string;
	availableForUsd: boolean;
	availableForSol: boolean;
	allowedModels: string[] | null;
}

const emptyForm: ProductFormData = {
	name: "",
	description: "",
	monthlyImageLimit: "",
	monthlyCostLimit: "",
	dailyImageLimit: "",
	bonusCredits: "0",
	price: "0",
	priceSol: "",
	availableForUsd: true,
	availableForSol: false,
	allowedModels: null,
};

export default function AdminProducts() {
	const { token } = useAuth();
	const { products, loading, fetchProducts, createProduct, updateProduct, deleteProduct } =
		useAdminProducts(token);
	const [showForm, setShowForm] = useState(false);
	const [editingProduct, setEditingProduct] = useState<SubscriptionProduct | null>(null);
	const [formData, setFormData] = useState<ProductFormData>(emptyForm);
	const [availableModels, setAvailableModels] = useState<Model[]>([]);

	const fetchModels = useCallback(async () => {
		try {
			const res = await fetch(`${API_BASE}/api/models`);
			if (res.ok) {
				const data = await res.json();
				setAvailableModels(data.models || []);
			}
		} catch (err) {
			console.error("Failed to fetch models:", err);
		}
	}, []);

	useEffect(() => {
		fetchProducts();
		fetchModels();
	}, [fetchProducts, fetchModels]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!formData.name) return;

		const productData = {
			name: formData.name,
			description: formData.description || undefined,
			monthlyImageLimit: formData.monthlyImageLimit
				? Number.parseInt(formData.monthlyImageLimit, 10)
				: undefined,
			monthlyCostLimit: formData.monthlyCostLimit
				? Number.parseFloat(formData.monthlyCostLimit)
				: undefined,
			dailyImageLimit: formData.dailyImageLimit
				? Number.parseInt(formData.dailyImageLimit, 10)
				: undefined,
			bonusCredits: Number.parseInt(formData.bonusCredits || "0", 10),
			price: Number.parseFloat(formData.price || "0"),
			priceSol: formData.priceSol ? Number.parseFloat(formData.priceSol) : undefined,
			availableForUsd: formData.availableForUsd,
			availableForSol: formData.availableForSol,
			allowedModels: formData.allowedModels,
		};

		if (editingProduct) {
			const success = await updateProduct(editingProduct.id, productData);
			if (success) {
				setShowForm(false);
				setEditingProduct(null);
				setFormData(emptyForm);
				fetchProducts();
			}
		} else {
			const result = await createProduct(productData);
			if (result) {
				setShowForm(false);
				setFormData(emptyForm);
				fetchProducts();
			}
		}
	};

	const handleEdit = (product: SubscriptionProduct) => {
		setEditingProduct(product);
		setFormData({
			name: product.name,
			description: product.description || "",
			monthlyImageLimit: product.monthlyImageLimit?.toString() || "",
			monthlyCostLimit: product.monthlyCostLimit?.toString() || "",
			dailyImageLimit: product.dailyImageLimit?.toString() || "",
			bonusCredits: product.bonusCredits.toString(),
			price: product.price.toString(),
			priceSol: product.priceSol?.toString() || "",
			availableForUsd: product.availableForUsd,
			availableForSol: product.availableForSol,
			allowedModels: product.allowedModels,
		});
		setShowForm(true);
	};

	const toggleModel = (modelId: string) => {
		setFormData((prev) => {
			// If currently null (all models), switch to all models except this one
			if (prev.allowedModels === null) {
				const allModelIds = availableModels.map((m) => m.id);
				return { ...prev, allowedModels: allModelIds.filter((id) => id !== modelId) };
			}
			// If model is in list, remove it
			if (prev.allowedModels.includes(modelId)) {
				const newAllowed = prev.allowedModels.filter((id) => id !== modelId);
				return { ...prev, allowedModels: newAllowed.length > 0 ? newAllowed : [] };
			}
			// If model is not in list, add it
			return { ...prev, allowedModels: [...prev.allowedModels, modelId] };
		});
	};

	const toggleAllModels = () => {
		setFormData((prev) => {
			if (prev.allowedModels === null) {
				// Currently all models - switch to none
				return { ...prev, allowedModels: [] };
			}
			// Switch to all models (null)
			return { ...prev, allowedModels: null };
		});
	};

	const handleDelete = async (product: SubscriptionProduct) => {
		if (!confirm(`Are you sure you want to deactivate "${product.name}"?`)) return;
		const success = await deleteProduct(product.id);
		if (success) {
			fetchProducts();
		}
	};

	const handleToggleActive = async (product: SubscriptionProduct) => {
		const success = await updateProduct(product.id, { isActive: !product.isActive });
		if (success) {
			fetchProducts();
		}
	};

	return (
		<div className="p-4">
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-xl font-bold gradient-text">Products</h1>
				<Button
					variant="primary"
					onClick={() => {
						setEditingProduct(null);
						setFormData(emptyForm);
						setShowForm(true);
					}}
					className="flex items-center gap-1"
				>
					<IconPlus className="w-4 h-4" />
					New
				</Button>
			</div>

			{/* Products grid */}
			{loading && products.length === 0 ? (
				<div className="text-gray-400 text-sm">Loading...</div>
			) : products.length === 0 ? (
				<div className="text-center py-8 text-gray-400">
					<p className="text-sm">No products yet.</p>
					<p className="text-xs mt-1">Create your first product.</p>
				</div>
			) : (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
					{products.map((product) => (
						<div
							key={product.id}
							className={`cyber-card rounded p-3 ${!product.isActive ? "opacity-50" : ""}`}
						>
							<div className="flex items-start justify-between mb-2">
								<div>
									<h3 className="text-sm font-semibold">{product.name}</h3>
									<div className="flex gap-1 mt-0.5">
										{!product.isActive && <span className="text-[10px] text-red-400">Inactive</span>}
										{product.availableForUsd && <span className="text-[10px] px-1 bg-green-500/20 text-green-400 rounded">USD</span>}
										{product.availableForSol && <span className="text-[10px] px-1 bg-purple-500/20 text-purple-400 rounded">SOL</span>}
									</div>
								</div>
								<div className="text-right">
									<div className="text-lg font-bold text-pink-400">
										{product.price > 0 ? `$${product.price}` : "Free"}
									</div>
									{product.priceSol != null && product.priceSol > 0 && (
										<div className="text-xs text-purple-400">{product.priceSol} SOL</div>
									)}
								</div>
							</div>

							{product.description && (
								<p className="text-gray-400 text-xs mb-2 line-clamp-2">{product.description}</p>
							)}

							<div className="space-y-1 mb-3 text-xs">
								<div className="flex justify-between">
									<span className="text-gray-500">Images/day</span>
									<span className="text-cyan-400">{product.dailyImageLimit ?? "∞"}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-gray-500">Images/mo</span>
									<span className="text-cyan-400">{product.monthlyImageLimit ?? "∞"}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-gray-500">Cost/mo</span>
									<span className="text-cyan-400">{product.monthlyCostLimit ? `$${product.monthlyCostLimit}` : "∞"}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-gray-500">Models</span>
									<span className="text-cyan-400">
										{product.allowedModels === null ? "All" : product.allowedModels.length}
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-gray-500">Bonus</span>
									<span>{product.bonusCredits}</span>
								</div>
								<div className="flex justify-between">
									<span className="text-gray-500">Users</span>
									<span>{product.activeUsers || 0}</span>
								</div>
							</div>

							<div className="flex gap-1.5 pt-2 border-t border-cyan-500/20">
								<button
									type="button"
									onClick={() => handleEdit(product)}
									className="flex-1 px-2 py-1 cyber-card hover:neon-border rounded text-xs transition-all"
								>
									Edit
								</button>
								<button
									type="button"
									onClick={() => handleToggleActive(product)}
									className={`flex-1 px-2 py-1 rounded text-xs transition-colors ${product.isActive ? "bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30" : "bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30"}`}
								>
									{product.isActive ? "Off" : "On"}
								</button>
								{!product.isActive && (
									<button
										type="button"
										onClick={() => handleDelete(product)}
										className="px-2 py-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded text-xs transition-colors"
									>
										Del
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			)}

			{/* Product form modal */}
			<Modal
				isOpen={showForm}
				onClose={() => {
					setShowForm(false);
					setEditingProduct(null);
				}}
				title={editingProduct ? "Edit Product" : "New Product"}
				size="sm"
			>
				<form onSubmit={handleSubmit} className="space-y-3">
					<div>
						<label htmlFor="product-name" className="block text-xs font-medium text-gray-400 mb-1">Name *</label>
						<input
							id="product-name"
							type="text"
							value={formData.name}
							onChange={(e) => setFormData({ ...formData, name: e.target.value })}
							placeholder="e.g., Pro, Enterprise"
							className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							required
						/>
					</div>

					<div>
						<label htmlFor="product-description" className="block text-xs font-medium text-gray-400 mb-1">Description</label>
						<textarea
							id="product-description"
							value={formData.description}
							onChange={(e) => setFormData({ ...formData, description: e.target.value })}
							placeholder="Brief description"
							className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							rows={2}
						/>
					</div>

					<div className="grid grid-cols-3 gap-2">
						<div>
							<label htmlFor="product-daily-limit" className="block text-xs font-medium text-gray-400 mb-1">Images/day</label>
							<input
								id="product-daily-limit"
								type="number"
								value={formData.dailyImageLimit}
								onChange={(e) => setFormData({ ...formData, dailyImageLimit: e.target.value })}
								placeholder="∞"
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							/>
						</div>
						<div>
							<label htmlFor="product-image-limit" className="block text-xs font-medium text-gray-400 mb-1">Images/mo</label>
							<input
								id="product-image-limit"
								type="number"
								value={formData.monthlyImageLimit}
								onChange={(e) => setFormData({ ...formData, monthlyImageLimit: e.target.value })}
								placeholder="∞"
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							/>
						</div>
						<div>
							<label htmlFor="product-cost-limit" className="block text-xs font-medium text-gray-400 mb-1">Cost/mo ($)</label>
							<input
								id="product-cost-limit"
								type="number"
								step="0.01"
								value={formData.monthlyCostLimit}
								onChange={(e) => setFormData({ ...formData, monthlyCostLimit: e.target.value })}
								placeholder="∞"
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							/>
						</div>
					</div>

					<div className="grid grid-cols-3 gap-2">
						<div>
							<label htmlFor="product-bonus-credits" className="block text-xs font-medium text-gray-400 mb-1">Bonus Credits</label>
							<input
								id="product-bonus-credits"
								type="number"
								value={formData.bonusCredits}
								onChange={(e) => setFormData({ ...formData, bonusCredits: e.target.value })}
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							/>
						</div>
						<div>
							<label htmlFor="product-price" className="block text-xs font-medium text-gray-400 mb-1">Price ($)</label>
							<input
								id="product-price"
								type="number"
								step="0.01"
								value={formData.price}
								onChange={(e) => setFormData({ ...formData, price: e.target.value })}
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							/>
						</div>
						<div>
							<label htmlFor="product-price-sol" className="block text-xs font-medium text-gray-400 mb-1">Price (SOL)</label>
							<input
								id="product-price-sol"
								type="number"
								step="0.01"
								value={formData.priceSol}
								onChange={(e) => setFormData({ ...formData, priceSol: e.target.value })}
								placeholder="Optional"
								className="cyber-input w-full px-2 py-1.5 rounded text-sm"
							/>
						</div>
					</div>

					{/* Purchase Availability */}
					<div className="flex gap-4 p-2 cyber-card rounded">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={formData.availableForUsd}
								onChange={(e) => setFormData({ ...formData, availableForUsd: e.target.checked })}
								className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-cyan-500"
							/>
							<span className="text-xs text-gray-300">Available for USD</span>
						</label>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={formData.availableForSol}
								onChange={(e) => setFormData({ ...formData, availableForSol: e.target.checked })}
								className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500"
							/>
							<span className="text-xs text-gray-300">Available for SOL</span>
						</label>
					</div>

					{/* Model Access */}
					<div>
						<div className="flex items-center justify-between mb-2">
							<label className="block text-xs font-medium text-gray-400">Allowed Models</label>
							<button
								type="button"
								onClick={toggleAllModels}
								className="text-[10px] text-cyan-400 hover:text-cyan-300"
							>
								{formData.allowedModels === null ? "Restrict to specific models" : "Allow all models"}
							</button>
						</div>
						{formData.allowedModels === null ? (
							<p className="text-xs text-gray-500 italic">All models are accessible</p>
						) : (
							<div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto cyber-card p-2 rounded">
								{availableModels.map((model) => (
									<label
										key={model.id}
										className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-cyan-500/10 p-1 rounded"
									>
										<input
											type="checkbox"
											checked={formData.allowedModels?.includes(model.id) || false}
											onChange={() => toggleModel(model.id)}
											className="w-3 h-3 rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0"
										/>
										<span className="truncate" title={model.name}>{model.name}</span>
									</label>
								))}
							</div>
						)}
						{formData.allowedModels !== null && (
							<p className="text-[10px] text-gray-500 mt-1">
								{formData.allowedModels.length} of {availableModels.length} models selected
							</p>
						)}
					</div>

					<div className="flex gap-2 pt-2">
						<Button
							variant="secondary"
							onClick={() => {
								setShowForm(false);
								setEditingProduct(null);
							}}
							className="flex-1"
						>
							Cancel
						</Button>
						<Button variant="primary" type="submit" className="flex-1">
							{editingProduct ? "Save" : "Create"}
						</Button>
					</div>
				</form>
			</Modal>
		</div>
	);
}
