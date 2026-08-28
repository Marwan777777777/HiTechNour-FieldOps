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
};

export type TimelineEvent = {
  id: number;
  type: "check_in" | "check_out";
  distance_meters: number;
  status: "inside" | "outside";
  flagged: boolean;
  flag_reason: string | null;
  created_at: string;
  site_name: string;
  site_id: number;
};

export type AssignmentRow = {
  id: number;
  site_id: number;
  site_name: string;
  task: string | null;
  start_date: string;
  end_date: string;
};
