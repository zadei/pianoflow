/**
 * Particle system for note hit effects.
 */
class ParticleSystem {
    constructor() {
        this.particles = [];
    }

    /**
     * Spawn a burst of particles at (x, y).
     * @param {number} x
     * @param {number} y
     * @param {string} color - CSS color
     * @param {number} count
     */
    emit(x, y, color, count = 12) {
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
            const speed = 80 + Math.random() * 120;
            this.particles.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: -Math.abs(Math.sin(angle) * speed) - 40, // bias upward
                life: 1.0,
                decay: 1.5 + Math.random() * 1.0,
                size: 2 + Math.random() * 3,
                color,
            });
        }
    }

    /**
     * Update all particles by dt seconds.
     * @param {number} dt
     */
    update(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 200 * dt; // gravity
            p.life -= p.decay * dt;
            if (p.life <= 0) {
                this.particles.splice(i, 1);
            }
        }
    }

    /**
     * Draw all particles onto a canvas context.
     * @param {CanvasRenderingContext2D} ctx
     */
    draw(ctx) {
        for (const p of this.particles) {
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}
