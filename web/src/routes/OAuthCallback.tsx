import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export const OAuthCallback = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { hydrateProfile } = useAuth();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const jwt = params.get("jwt");

    if (jwt) {
      console.info("[oauth-callback] received jwt");
      hydrateProfile(jwt).finally(() => {
        console.info("[oauth-callback] navigating to /studio");
        navigate("/studio", { replace: true });
      });
      return;
    }

    console.warn("[oauth-callback] missing jwt param, redirecting to /login");
    navigate("/login", { replace: true });
  }, [location.search, hydrateProfile, navigate]);

  return (
    <div className="grid min-h-screen place-items-center bg-slate-900/5 text-sm text-slate-500">
      Completing sign in...
    </div>
  );
};
