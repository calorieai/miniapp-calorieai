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

        // 1. Strictly Check Active Premium Subscription
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = new Date();
        const isSubscriptionValid = Boolean(
            (user.isPremium && !user.subscriptionExpiresAt) ||
            (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now)
        );

        if (!isSubscriptionValid) {
            // Keep DB isPremium flag synchronized if expired
            if (user.isPremium) {
                await prisma.user.update({
                    where: { id: userId },
                    data: { isPremium: false }
                });
            }
            return res.status(403).json({
                error: 'Для сканирования и анализа блюд требуется активная подписка Premium',
                code: 'PREMIUM_REQUIRED'
            });
        }

        // Keep DB isPremium flag synchronized if active via subscriptionExpiresAt
        if (!user.isPremium && user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now) {
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
