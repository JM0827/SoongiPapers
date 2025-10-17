import { type ReactElement, useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";

interface ProtectedRouteProps {
  children: ReactElement;
}

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { token, user, hydrateProfile, isHydrating } = useAuth();
  const location = useLocation();

  useEffect(() => {
    hydrateProfile();
  }, [hydrateProfile]);

  if (isHydrating) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-500">
        Loading session...
      </div>
    );
  }

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!user) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-500">
        Restoring profile...
      </div>
    );
  }

  return children;
};
