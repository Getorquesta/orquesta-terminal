import { cn } from '@/lib/utils'
import { InputHTMLAttributes, forwardRef } from 'react'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={id} className="text-sm font-medium text-zinc-300">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className={cn(
            'h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-1 text-sm text-white shadow-inner shadow-black/20 transition-colors placeholder:text-zinc-500 hover:border-zinc-600 focus:border-green-600/60 focus:outline-none focus:ring-2 focus:ring-green-600/40 disabled:opacity-50',
            error && 'border-red-500/70 focus:border-red-500 focus:ring-red-500/40',
            className
          )}
          {...props}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
