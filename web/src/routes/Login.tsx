import { translate } from "../lib/locale";
import { useAuth } from "../hooks/useAuth";

export const Login = () => {
  const { login } = useAuth();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-900/5 p-6 text-center">
      <h1 className="text-2xl font-semibold text-slate-800">
        Project-T1 Studio
      </h1>
      <p className="max-w-md text-sm text-slate-600">{translate("welcome")}</p>
      <button
        onClick={login}
        className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-500"
      >
        {translate("login_action")}
      </button>
    </div>
  );
};
