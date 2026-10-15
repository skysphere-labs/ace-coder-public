import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from './ui/button';
import { Input } from './ui/input';

export type PromptRequest = {
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void;
};

export function PromptDialog({
  request,
  onClose,
}: {
  request: PromptRequest | null;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {request && <PromptDialogContent request={request} onClose={onClose} />}
    </AnimatePresence>
  );
}

function PromptDialogContent({
  request,
  onClose,
}: {
  request: PromptRequest;
  onClose: () => void;
}) {
  const [value, setValue] = useState(request.defaultValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 30);
    return () => window.clearTimeout(id);
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (request.validate) {
      const err = request.validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    request.onConfirm(trimmed);
    onClose();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="glass-overlay fixed inset-0 z-[200] flex items-center justify-center"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface w-full max-w-md overflow-hidden rounded-2xl"
      >
        <div className="px-6 pt-6">
          <h2 className="font-display text-base font-semibold tracking-tight">
            {request.title}
          </h2>
          {request.description && (
            <p className="mt-1 text-xs text-muted-foreground">
              {request.description}
            </p>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="px-6 pb-6 pt-4"
        >
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder={request.placeholder}
            className="h-9 text-sm"
          />
          {error && (
            <p className="mt-1.5 text-[11px] text-red-300/85">{error}</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm">
              {request.confirmLabel ?? 'OK'}
            </Button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
