import { forwardRef } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva('ui-button', {
  variants: {
    variant: {
      default: 'ui-button--default',
      primary: 'ui-button--primary',
      ghost: 'ui-button--ghost',
      outline: 'ui-button--outline',
    },
    size: {
      default: 'ui-button--md',
      sm: 'ui-button--sm',
      icon: 'ui-button--icon',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export const Button = forwardRef(function Button({ className, variant, size, type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
