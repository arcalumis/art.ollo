import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";

interface ModelCost {
	id: string;
	name: string;
	category: string;
	creditCost: number;
	isOverride: boolean;
	baseCostUsd: number;
}

const categoryColors: Record<string, string> = {
	fast: "bg-green-500/20 text-green-400",
	quality: "bg-cyan-500/20 text-cyan-400",
	ultra: "bg-purple-500/20 text-purple-400",
	variation: "bg-yellow-500/20 text-yellow-400",
	edit: "bg-pink-500/20 text-pink-400",
	external: "bg-orange-500/20 text-orange-400",
};

export default function AdminModels() {
	const { token } = useAuth();
	const [models, setModels] = useState<ModelCost[]>([]);
	const [loading, setLoading] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const [saving, setSaving] = useState<string | null>(null);

	const fetchModels = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const res = await fetch(`${API_BASE}/api/admin/model-costs`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (res.ok) {
				const data = await res.json();
				setModels(data.models || []);
			}
		} catch (err) {
			console.error("Failed to fetch model costs:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	useEffect(() => {
		fetchModels();
	}, [fetchModels]);

	const handleEdit = (model: ModelCost) => {
		setEditingId(model.id);
		setEditValue(model.creditCost.toString());
	};

	const handleCancel = () => {
		setEditingId(null);
		setEditValue("");
	};

	const handleSave = async (modelId: string) => {
		const cost = Number.parseInt(editValue, 10);
		if (Number.isNaN(cost) || cost < 0) return;

		setSaving(modelId);
		try {
			const res = await fetch(
				`${API_BASE}/api/admin/model-costs/${encodeURIComponent(modelId)}`,
				{
					method: "PATCH",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ creditCost: cost }),
				},
			);
			if (res.ok) {
				setEditingId(null);
				setEditValue("");
				fetchModels();
			}
		} catch (err) {
			console.error("Failed to save model cost:", err);
		} finally {
			setSaving(null);
		}
	};

	const handleReset = async (modelId: string) => {
		setSaving(modelId);
		try {
			const res = await fetch(
				`${API_BASE}/api/admin/model-costs/${encodeURIComponent(modelId)}`,
				{
					method: "DELETE",
					headers: { Authorization: `Bearer ${token}` },
				},
			);
			if (res.ok) {
				setEditingId(null);
				fetchModels();
			}
		} catch (err) {
			console.error("Failed to reset model cost:", err);
		} finally {
			setSaving(null);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent, modelId: string) => {
		if (e.key === "Enter") handleSave(modelId);
		if (e.key === "Escape") handleCancel();
	};

	return (
		<div className="p-4">
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-xl font-bold gradient-text">Model Credit Costs</h1>
				<p className="text-xs text-gray-500">
					Credits deducted per generation. Overrides are stored in the database.
				</p>
			</div>

			{loading && models.length === 0 ? (
				<div className="text-gray-400 text-sm">Loading...</div>
			) : (
				<div className="cyber-card rounded overflow-hidden">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-cyan-500/20 text-left">
								<th className="px-3 py-2 text-xs font-medium text-gray-400">Model</th>
								<th className="px-3 py-2 text-xs font-medium text-gray-400">Category</th>
								<th className="px-3 py-2 text-xs font-medium text-gray-400 text-right">USD Cost</th>
								<th className="px-3 py-2 text-xs font-medium text-gray-400 text-right">Credits</th>
								<th className="px-3 py-2 text-xs font-medium text-gray-400 text-right">Actions</th>
							</tr>
						</thead>
						<tbody>
							{models.map((model) => (
								<tr
									key={model.id}
									className="border-b border-cyan-500/10 hover:bg-cyan-500/5 transition-colors"
								>
									<td className="px-3 py-2">
										<div className="font-medium text-white">{model.name}</div>
										<div className="text-[10px] text-gray-500 font-mono">{model.id}</div>
									</td>
									<td className="px-3 py-2">
										<span
											className={`text-[10px] px-1.5 py-0.5 rounded ${categoryColors[model.category] || "bg-gray-500/20 text-gray-400"}`}
										>
											{model.category}
										</span>
									</td>
									<td className="px-3 py-2 text-right text-gray-400 font-mono text-xs">
										${model.baseCostUsd.toFixed(4)}
									</td>
									<td className="px-3 py-2 text-right">
										{editingId === model.id ? (
											<input
												type="number"
												min="0"
												step="1"
												value={editValue}
												onChange={(e) => setEditValue(e.target.value)}
												onKeyDown={(e) => handleKeyDown(e, model.id)}
												className="cyber-input w-16 px-2 py-0.5 rounded text-sm text-right"
												autoFocus
											/>
										) : (
											<button
												type="button"
												onClick={() => handleEdit(model)}
												className="inline-flex items-center gap-1 hover:bg-cyan-500/10 px-2 py-0.5 rounded transition-colors"
												title="Click to edit"
											>
												<span className="font-mono font-medium text-cyan-400">
													{model.creditCost}
												</span>
												{model.isOverride && (
													<span className="w-1.5 h-1.5 rounded-full bg-pink-400" title="Custom override" />
												)}
											</button>
										)}
									</td>
									<td className="px-3 py-2 text-right">
										<div className="flex items-center justify-end gap-1">
											{editingId === model.id ? (
												<>
													<button
														type="button"
														onClick={() => handleSave(model.id)}
														disabled={saving === model.id}
														className="px-2 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 rounded transition-colors disabled:opacity-50"
													>
														Save
													</button>
													<button
														type="button"
														onClick={handleCancel}
														className="px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-500/20 rounded transition-colors"
													>
														Cancel
													</button>
												</>
											) : (
												model.isOverride && (
													<button
														type="button"
														onClick={() => handleReset(model.id)}
														disabled={saving === model.id}
														className="px-2 py-0.5 text-xs text-yellow-400 hover:bg-yellow-500/20 rounded transition-colors disabled:opacity-50"
														title="Reset to hardcoded default"
													>
														Reset
													</button>
												)
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
