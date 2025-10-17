interface ApplyProofDialogProps {
  open: boolean;
  onClose: () => void;
}

export const ApplyProofDialog = ({ open, onClose }: ApplyProofDialogProps) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Apply proofreading changes</h3>
        <p className="mt-2 text-sm text-slate-600">
          This dialog will confirm which issues to apply to the translation.
          Wire it to the `/api/proofread/:id/apply` endpoint.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded border border-slate-300 px-3 py-1 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded bg-indigo-600 px-3 py-1 text-sm text-white"
            onClick={onClose}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};
