import { Router } from 'express';
import multer from 'multer';
import { analyzeFoodImage } from '../services/openai';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        const userId = req.body.userId;
        if (!userId) {
            return res.status(400).json({ error: 'User ID required for analysis' });
        }

        // 1. Check Premium Subscription or Daily Free Quota
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = new Date();
        const isSubscriptionValid = Boolean(
            user.isPremium ||
            (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now)
        );

        if (!isSubscriptionValid) {
            // Free Tier: 3 free scans per day
            const todayStr = now.toISOString().split('T')[0];
            const lastReqStr = user.lastRequestDate ? new Date(user.lastRequestDate).toISOString().split('T')[0] : '';
            const currentCount = (todayStr === lastReqStr) ? user.dailyRequestCount : 0;

            const FREE_DAILY_LIMIT = 3;
            if (currentCount >= FREE_DAILY_LIMIT) {
                return res.status(403).json({
                    error: `Дневной лимит бесплатных сканирований исчерпан (${FREE_DAILY_LIMIT}/${FREE_DAILY_LIMIT}). Оформите Premium для безлимитного доступа`,
                    code: 'LIMIT_REACHED'
                });
            }

            // Increment daily request count for free tier
            await prisma.user.update({
                where: { id: userId },
                data: {
                    dailyRequestCount: currentCount + 1,
                    lastRequestDate: now
                }
            });
        } else if (!user.isPremium && user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now) {
            // Keep DB isPremium flag synchronized with subscriptionExpiresAt
            await prisma.user.update({
                where: { id: userId },
                data: { isPremium: true }
            });
        }

        // Convert buffer to base64 for OpenAI
        const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        console.log(`[Analyze] User ${userId} starting analysis (Premium: ${user.isPremium})`);

        // Parallel execution: Analyze content AND Upload to CDN
        const analyzedPromise = analyzeFoodImage(base64Image);

        // Safe CDN upload: if Cloudinary fails, food analysis MUST still succeed!
        const uploadPromise = (async () => {
            try {
                const { uploadImage } = await import('../services/cloudinary');
                return await uploadImage(req.file!.buffer);
            } catch (err: any) {
                console.warn('⚠️ Cloudinary upload failed (continuing analysis without CDN):', err.message);
                return null;
            }
        })();

        const [analysisResult, photoUrl] = await Promise.all([analyzedPromise, uploadPromise]);

        console.log('Analysis and Upload complete.', { photoUrl });

        // Return both analysis and the pre-uploaded URL
        res.json({ ...analysisResult, photoUrl });
    } catch (error: any) {
        console.error('Analysis failed:', error);
        res.status(500).json({ error: error.message || 'Failed to analyze image' });
    }
});

export default router;
