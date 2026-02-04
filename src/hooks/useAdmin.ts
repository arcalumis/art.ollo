import { useCallback, useState } from "react";
import { API_BASE } from "../config";
import type {
	AdminStats,
	AdminUser,
	AdminUserDetail,
	CreditPackage,
	SubscriptionBoost,
	SubscriptionProduct,
} from "../types";

export function useAdminStats(token: string | null) {
	const [stats, setStats] = useState<AdminStats | null>(null);
	const [loading, setLoading] = useState(false);

	const fetchStats = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/admin/stats`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = (await response.json()) as AdminStats;
			setStats(data);
		} catch (err) {
			console.error("Failed to fetch admin stats:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	return { stats, loading, fetchStats };
}

interface UsersResponse {
	users: AdminUser[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export function useAdminUsers(token: string | null) {
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);

	const fetchUsers = useCallback(
		async (page = 1, limit = 20, search = "") => {
			if (!token) return;
			setLoading(true);
			try {
				const params = new URLSearchParams({ page: String(page), limit: String(limit) });
				if (search) params.set("search", search);

				const response = await fetch(`${API_BASE}/api/admin/users?${params}`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				const data = (await response.json()) as UsersResponse;
				setUsers(data.users);
				setTotal(data.total);
			} catch (err) {
				console.error("Failed to fetch users:", err);
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	const fetchUser = useCallback(
		async (userId: string): Promise<AdminUserDetail | null> => {
			if (!token) return null;
			try {
				const response = await fetch(`${API_BASE}/api/admin/users/${userId}`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				return (await response.json()) as AdminUserDetail;
			} catch (err) {
				console.error("Failed to fetch user:", err);
				return null;
			}
		},
		[token],
	);

	const updateUser = useCallback(
		async (
			userId: string,
			updates: { isAdmin?: boolean; isActive?: boolean; email?: string },
		): Promise<boolean> => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/admin/users/${userId}`, {
					method: "PATCH",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(updates),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to update user:", err);
				return false;
			}
		},
		[token],
	);

	const addCredits = useCallback(
		async (
			userId: string,
			amount: number,
			reason: string,
		): Promise<{ success: boolean; newBalance?: number }> => {
			if (!token) return { success: false };
			try {
				const response = await fetch(`${API_BASE}/api/admin/users/${userId}/credits`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ amount, reason }),
				});
				if (response.ok) {
					const data = (await response.json()) as { success: boolean; newBalance: number };
					return data;
				}
				return { success: false };
			} catch (err) {
				console.error("Failed to add credits:", err);
				return { success: false };
			}
		},
		[token],
	);

	const assignSubscription = useCallback(
		async (userId: string, productId: string): Promise<boolean> => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/admin/users/${userId}/subscription`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ productId }),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to assign subscription:", err);
				return false;
			}
		},
		[token],
	);

	const createUser = useCallback(
		async (data: {
			username: string;
			email: string;
			password?: string;
			sendEmail?: boolean;
		}): Promise<{
			success: boolean;
			user?: {
				id: string;
				username: string;
				email: string;
				generatedPassword?: string;
				emailSent: boolean;
				emailError?: string;
			};
			error?: string;
		}> => {
			if (!token) return { success: false, error: "Not authenticated" };
			try {
				const response = await fetch(`${API_BASE}/api/admin/users`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(data),
				});
				const result = await response.json();
				if (response.ok) {
					return { success: true, user: result };
				}
				return { success: false, error: result.error || "Failed to create user" };
			} catch (err) {
				console.error("Failed to create user:", err);
				return { success: false, error: "Failed to create user" };
			}
		},
		[token],
	);

	return {
		users,
		total,
		loading,
		fetchUsers,
		fetchUser,
		updateUser,
		addCredits,
		assignSubscription,
		createUser,
	};
}

interface ProductsResponse {
	products: SubscriptionProduct[];
}

export function useAdminProducts(token: string | null) {
	const [products, setProducts] = useState<SubscriptionProduct[]>([]);
	const [loading, setLoading] = useState(false);

	const fetchProducts = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/admin/products`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = (await response.json()) as ProductsResponse;
			setProducts(data.products);
		} catch (err) {
			console.error("Failed to fetch products:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	const createProduct = useCallback(
		async (product: {
			name: string;
			description?: string;
			monthlyImageLimit?: number;
			monthlyCostLimit?: number;
			bonusCredits?: number;
			price?: number;
		}): Promise<SubscriptionProduct | null> => {
			if (!token) return null;
			try {
				const response = await fetch(`${API_BASE}/api/admin/products`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(product),
				});
				if (response.ok) {
					return (await response.json()) as SubscriptionProduct;
				}
				return null;
			} catch (err) {
				console.error("Failed to create product:", err);
				return null;
			}
		},
		[token],
	);

	const updateProduct = useCallback(
		async (
			productId: string,
			updates: {
				name?: string;
				description?: string;
				monthlyImageLimit?: number | null;
				monthlyCostLimit?: number | null;
				bonusCredits?: number;
				price?: number;
				isActive?: boolean;
			},
		): Promise<boolean> => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/admin/products/${productId}`, {
					method: "PATCH",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(updates),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to update product:", err);
				return false;
			}
		},
		[token],
	);

	const deleteProduct = useCallback(
		async (productId: string): Promise<boolean> => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/admin/products/${productId}`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${token}` },
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to delete product:", err);
				return false;
			}
		},
		[token],
	);

	return { products, loading, fetchProducts, createProduct, updateProduct, deleteProduct };
}

// ============================================
// CREDIT PACKAGES
// ============================================

interface CreditPackagesResponse {
	packages: CreditPackage[];
}

export function useAdminCreditPackages(token: string | null) {
	const [packages, setPackages] = useState<CreditPackage[]>([]);
	const [loading, setLoading] = useState(false);

	const fetchPackages = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/admin/credit-packages`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = (await response.json()) as CreditPackagesResponse;
			setPackages(data.packages);
		} catch (err) {
			console.error("Failed to fetch credit packages:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	const createPackage = useCallback(
		async (data: {
			name: string;
			credits: number;
			priceSol: number;
			isActive?: boolean;
		}): Promise<CreditPackage | null> => {
			if (!token) return null;
			try {
				const response = await fetch(`${API_BASE}/api/admin/credit-packages`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(data),
				});
				if (response.ok) {
					return (await response.json()) as CreditPackage;
				}
				return null;
			} catch (err) {
				console.error("Failed to create credit package:", err);
				return null;
			}
		},
		[token],
	);

	const updatePackage = useCallback(
		async (
			id: string,
			updates: {
				name?: string;
				credits?: number;
				priceSol?: number;
				isActive?: boolean;
			},
		): Promise<boolean> => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/admin/credit-packages/${id}`, {
					method: "PATCH",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(updates),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to update credit package:", err);
				return false;
			}
		},
		[token],
	);

	const deletePackage = useCallback(
		async (id: string): Promise<boolean> => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/admin/credit-packages/${id}`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${token}` },
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to delete credit package:", err);
				return false;
			}
		},
		[token],
	);

	return { packages, loading, fetchPackages, createPackage, updatePackage, deletePackage };
}

// ============================================
// SUBSCRIPTION BOOSTS
// ============================================

interface BoostsResponse {
	boosts: SubscriptionBoost[];
}

interface BoostResponse {
	boost: SubscriptionBoost | null;
}

export function useAdminBoosts(token: string | null) {
	const [boosts, setBoosts] = useState<SubscriptionBoost[]>([]);
	const [loading, setLoading] = useState(false);

	const fetchBoosts = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/admin/boosts`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = (await response.json()) as BoostsResponse;
			setBoosts(data.boosts);
		} catch (err) {
			console.error("Failed to fetch boosts:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	const getUserBoost = useCallback(
		async (userId: string): Promise<SubscriptionBoost | null> => {
			if (!token) return null;
			try {
				const response = await fetch(`${API_BASE}/api/admin/users/${userId}/boost`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (response.ok) {
					const data = (await response.json()) as BoostResponse;
					return data.boost;
				}
				return null;
			} catch (err) {
				console.error("Failed to get user boost:", err);
				return null;
			}
		},
		[token],
	);

	const grantBoost = useCallback(
		async (
			userId: string,
			productId: string,
			durationDays?: number,
			reason?: string,
		): Promise<{ success: boolean; boost?: SubscriptionBoost }> => {
			if (!token) return { success: false };
			try {
				const response = await fetch(`${API_BASE}/api/admin/users/${userId}/boost`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ productId, durationDays, reason }),
				});
				if (response.ok) {
					const data = (await response.json()) as { success: boolean; boost: SubscriptionBoost };
					return data;
				}
				return { success: false };
			} catch (err) {
				console.error("Failed to grant boost:", err);
				return { success: false };
			}
		},
		[token],
	);

	const cancelBoost = useCallback(
		async (userId: string): Promise<boolean> => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/admin/users/${userId}/boost`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${token}` },
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to cancel boost:", err);
				return false;
			}
		},
		[token],
	);

	return { boosts, loading, fetchBoosts, getUserBoost, grantBoost, cancelBoost };
}
