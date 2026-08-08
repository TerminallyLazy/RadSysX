"use client";

import { useToast } from "@/lib/use-toast";

export function Toaster() {
  const { toasts } = useToast();

  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts
        .filter((toast) => toast.open !== false)
        .map((toast) => (
          <div
            key={toast.id}
            className={`
              relative p-4 pr-10 rounded-lg shadow-lg max-w-sm cursor-pointer
              transition-all duration-200 animate-in slide-in-from-right
              ${toast.variant === 'destructive'
                ? 'bg-red-500 text-white'
                : 'bg-white text-gray-900 border border-gray-200 dark:bg-gray-800 dark:text-white dark:border-gray-700'
              }
            `}
            onClick={() => toast.onOpenChange?.(false)}
          >
            <button
              className={`
                absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full
                transition-colors text-sm font-bold leading-none
                ${toast.variant === 'destructive'
                  ? 'hover:bg-red-600 text-white/80 hover:text-white'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'
                }
              `}
              onClick={(e) => {
                e.stopPropagation();
                toast.onOpenChange?.(false);
              }}
              aria-label="Dismiss"
            >
              ×
            </button>
            <div className="font-semibold">{toast.title}</div>
            {toast.description && (
              <div className="text-sm mt-1 opacity-90">{toast.description}</div>
            )}
          </div>
        ))}
    </div>
  );
}
