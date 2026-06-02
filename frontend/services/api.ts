import axios from "axios";

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1",
  headers: { "Content-Type": "application/json" },
  withCredentials: false,
});

// Attach access token
api.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const raw = localStorage.getItem("efms-auth");
    if (raw) {
      try {
        const { state } = JSON.parse(raw);
        if (state?.accessToken) {
          config.headers.Authorization = `Bearer ${state.accessToken}`;
        }
      } catch {}
    }
  }
  return config;
});

// 401 handler with refresh token rotation
let refreshing = false;
let queue: Array<{ resolve: (token: string) => void; reject: (e: unknown) => void }> = [];

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const orig = error.config;
    if (error.response?.status === 401 && !orig._retry) {
      orig._retry = true;
      if (refreshing) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve, reject });
        }).then((token) => {
          orig.headers.Authorization = `Bearer ${token}`;
          return api(orig);
        });
      }
      refreshing = true;
      try {
        const raw = localStorage.getItem("efms-auth");
        const { state } = JSON.parse(raw ?? "{}");
        const { data } = await axios.post(
          `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1"}/auth/refresh`,
          { refresh_token: state?.refreshToken }
        );
        const newAccess = data.access_token;
        const parsed = JSON.parse(raw ?? "{}");
        parsed.state.accessToken = newAccess;
        parsed.state.refreshToken = data.refresh_token;
        localStorage.setItem("efms-auth", JSON.stringify(parsed));
        queue.forEach((p) => p.resolve(newAccess));
        queue = [];
        orig.headers.Authorization = `Bearer ${newAccess}`;
        return api(orig);
      } catch (e) {
        queue.forEach((p) => p.reject(e));
        queue = [];
        localStorage.removeItem("efms-auth");
        window.location.href = "/login";
        return Promise.reject(e);
      } finally {
        refreshing = false;
      }
    }
    return Promise.reject(error);
  }
);

export function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (data?.detail) return typeof data.detail === "string" ? data.detail : "An error occurred.";
    if (data?.message) return data.message;
    if (error.response?.status === 403) return "You don't have permission to perform this action.";
    if (error.response?.status === 404) return "The requested resource was not found.";
    if (error.response?.status === 422) return "Invalid data submitted. Please check your form.";
    if (error.response?.status === 500) return "Server error. Please try again later.";
    if (error.code === "ECONNREFUSED" || error.code === "ERR_NETWORK") return "Cannot connect to server. Please check your network.";
  }
  return "An unexpected error occurred. Please try again.";
}
