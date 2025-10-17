import { FastifyRequest, FastifyReply } from "fastify";
import * as jwt from "jsonwebtoken";
import { query } from "../db";

export async function requireAuthAndPlanCheck(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply
        .status(401)
        .send({ error: "Missing or invalid Authorization header" });
    }
    const token = auth.replace("Bearer ", "");
    const jwtSecret = process.env.JWT_SECRET || "dev_secret";
    let payload: any;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch (e) {
      return reply.status(401).send({ error: "Invalid or expired token" });
    }
    const user_id = payload.user_id;

    // 플랜 조회
    let plan: any = null;
    try {
      const subRes = await query(
        `SELECT us.*, sp.* FROM user_subscriptions us
         JOIN service_plans sp ON us.plan_id = sp.id
         WHERE us.user_id = $1 AND us.is_active = true
         ORDER BY us.started_at DESC LIMIT 1`,
        [user_id],
      );

      if (subRes.rows.length === 0) {
        const freePlanRes = await query(
          "SELECT * FROM service_plans WHERE name = $1",
          ["Free"],
        );
        if (freePlanRes.rows.length) {
          plan = freePlanRes.rows[0];
        } else {
          // Seed a minimal fallback free plan so authentication never hard fails
          await query(
            `INSERT INTO service_plans (name, description, is_active)
             VALUES ($1, $2, true)
             ON CONFLICT (name) DO NOTHING`,
            ["Free", "Default free tier"],
          );
          plan = { name: "Free" };
        }
      } else {
        plan = subRes.rows[0];
      }
    } catch (planError: any) {
      // When service_plans or user_subscriptions are not ready yet, fall back to a Free plan
      req.log.warn(
        { err: planError },
        "[AUTH] Falling back to default Free plan",
      );
      plan = { name: "Free" };
    }

    // (선택) 라이선스 체크
    if (plan.name === "Pro" || plan.name === "Enterprise") {
      const licRes = await query(
        "SELECT * FROM licenses WHERE user_id = $1 AND is_valid = true",
        [user_id],
      );
      if (licRes.rows.length === 0) {
        return reply
          .status(403)
          .send({ error: "Valid license required for this plan" });
      }
    }

    (req as any).user_id = user_id;
  } catch (e: any) {
    return reply
      .status(500)
      .send({ error: "Plan/license check failed: " + e.message });
  }
}
