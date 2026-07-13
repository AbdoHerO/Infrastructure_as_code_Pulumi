import { forwardRef, type LabelHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

/** Form label styled to the design system. */
export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  function Label({ className, ...props }, ref) {
    return (
      <label
        ref={ref}
        className={cn('text-foreground text-sm font-medium leading-none', className)}
        {...props}
      />
    );
  },
);
