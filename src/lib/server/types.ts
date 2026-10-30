export type Role = "admin" | "employee";

export type Profile = {
  user_id: string;
  email: string | null;
  username: string | null;
  full_name: string;
  phone: string | null;
  title: string | null;
  role: Role;
  locale: string;
  device_id: string | null;
  pending_device_id: string | null;
  device_approved: boolean;
  device_bound_at: string | null;
  device_public_key?: string | null;
  pending_device_public_key?: string | null;
  device_webauthn_id?: string | null;
  pending_device_webauthn_id?: string | null;
  token_version: number;
  active: boolean;
};

export type Site = {
  id: number;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  radius_meters: number;
  active: boolean;
  group_id?: number | null;
  group_name?: string | null;
};

export type TimelineEvent = {
  id: number;
  type: "check_in" | "check_out";
  distance_meters: number;
  status: "inside" | "outside";
  flagged: boolean;
  flag_reason: string | null;
  created_at: string;
  actual_time?: string;
  site_name: string;
  site_id: number;
  source?: "gps" | "manual";
  is_manual?: boolean;
  is_reversed?: boolean;
  reason?: string | null;
};

export type AttendanceRequestRow = {
  id: number;
  user_id: string;
  site_id: number;
  site_name?: string;
  type: "check_in" | "check_out";
  attempted_at: string;
  gps_fix_at?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy_meters?: number | null;
  distance_meters?: number | null;
  advisory_state: string;
  reason: string;
  device_id: string;
  status: "pending" | "approved" | "rejected";
  request_kind?: "rejected_punch" | "review_request";
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  admin_notes?: string | null;
  created_at: string;
};

export type AssignmentRow = {
  id: number;
  site_id: number;
  site_name: string;
  task: string | null;
  notes?: string | null;
  status?: "draft" | "published";
  start_date: string;
  end_date: string;
};
