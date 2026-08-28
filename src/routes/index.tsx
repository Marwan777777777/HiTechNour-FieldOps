import { createFileRoute } from "@tanstack/react-router";
import { FieldApp } from "@/components/field-app";
import { LoginScreen } from "@/components/login-screen";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, isPending } = useCurrentUserState();
  if (isPending || !user) return <LoginScreen />;
  return (
    <FieldApp
      email={user.primaryEmail ?? undefined}
      displayName={user.displayName ?? undefined}
    />
  );
}
