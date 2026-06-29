export type TaskStatus = "pending" | "running" | "waiting" | "done" | "failed";

export interface Product {
  id: string;
  name: string;
  mode: "image_to_video" | "text_to_video" | "ai_avatar" | "remix";
  url?: string;
  image?: string;
  prompt?: string;
  language?: string;
  country?: string;
  created_at?: string;
}

export interface Task {
  id: string;
  product_id: string;
  product_name: string;
  mode: string;
  status: TaskStatus;
  retries: number;
  error?: string;
  duration?: number;
  started_at?: string;
  finished_at?: string;
}

export interface DashboardStats {
  today_total: number;
  today_success: number;
  today_failed: number;
  success_rate: number;
  queue: { pending: number; running: number; done: number };
  recent: Task[];
}

export interface Video {
  id: string;
  name: string;
  mode: string;
  thumbnail?: string;
  url: string;
  duration?: number;
  size?: number;
  created_at: string;
}

export interface Settings {
  max_concurrent_tabs: number;
  video_timeout_seconds: number;
  poll_interval_seconds: number;
  delay_min: number;
  delay_max: number;
  output_dir: string;
  session_active?: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

export interface ProgressEvent {
  task_id?: string;
  status?: TaskStatus;
  message?: string;
  completed: number;
  total: number;
  current?: string;
}
