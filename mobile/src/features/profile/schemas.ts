import { z } from 'zod';

import { isValidUkMobile } from '../../lib/phone';

export const editProfileSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your full name'),
    email: z.union([z.literal(''), z.string().email('Enter a valid email address')]),
    mobile: z.string().min(1, 'Mobile number is required').refine(isValidUkMobile, 'Enter a valid UK mobile number'),
    currentPassword: z.string(),
    newPassword: z.string(),
    avatarUri: z.string().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.newPassword.length > 0 && values.newPassword.length < 8) {
      ctx.addIssue({ code: 'custom', path: ['newPassword'], message: 'Password must be at least 8 characters' });
    }
    if (values.newPassword.length > 0 && values.currentPassword.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['currentPassword'], message: 'Enter your current password' });
    }
  });

export type EditProfileFormValues = z.infer<typeof editProfileSchema>;
