"use client";

import { useEffect, useRef } from "react";

type RingSpec = { radius: number; tube: number; flatten: number; amp: number; waves: number; speed: number; phase: number; opacity: number };

const RINGS: RingSpec[] = [
  { radius: 2.9, tube: 0.36, flatten: 0.26, amp: 0.2, waves: 3, speed: 0.9, phase: 0, opacity: 0.9 },
  { radius: 2.05, tube: 0.22, flatten: 0.32, amp: 0.14, waves: 4, speed: -0.65, phase: 1.9, opacity: 0.7 },
  { radius: 3.75, tube: 0.12, flatten: 0.4, amp: 0.1, waves: 5, speed: 0.45, phase: 3.1, opacity: 0.5 },
];
const TUBULAR = 360;
const RADIAL = 40;

/// Glossy "ripples in a well" hero scene. Renders nothing if WebGL is unavailable.
export function HeroWell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let disposed = false;
    let teardown = () => {};

    (async () => {
      const THREE = await import("three");
      const canvas = canvasRef.current;
      if (disposed || !canvas) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      } catch {
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.35;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      camera.position.set(0, 0, 13);

      const studio = new THREE.Scene();
      studio.background = new THREE.Color(0x041210);
      const light = (w: number, h: number, color: number, power: number, p: [number, number, number], r: [number, number, number]) => {
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(w, h),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide })
        );
        mesh.position.set(...p);
        mesh.rotation.set(...r);
        studio.add(mesh);
      };
      light(16, 3, 0x3fe0b8, 3.2, [-7, 2.5, -1], [0, Math.PI / 2.3, 0]);
      light(12, 2.2, 0x1fa7c4, 2.6, [7, -1.5, 1], [0, -Math.PI / 2.1, 0]);
      light(9, 9, 0xffffff, 0.45, [0, 10, 2], [Math.PI / 2, 0, 0]);
      light(5, 0.6, 0xd9fff5, 1.1, [-2, -3.5, 9], [0, Math.PI, 0]);
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTexture = pmrem.fromScene(studio, 0.04).texture;
      scene.environment = envTexture;

      const rim = new THREE.DirectionalLight(0x3fe0b8, 2.4);
      rim.position.set(-4, 4, -3);
      const key = new THREE.DirectionalLight(0xffffff, 0.3);
      key.position.set(3, 5, 6);
      scene.add(rim, key);

      const group = new THREE.Group();
      group.position.y = -0.2;
      scene.add(group);

      const rings = RINGS.map((spec) => {
        const geometry = new THREE.TorusGeometry(spec.radius, spec.tube, RADIAL, TUBULAR);
        const base = Float32Array.from(geometry.attributes.position.array as Float32Array);
        const angle = new Float32Array(base.length / 3);
        for (let v = 0; v < angle.length; v++) angle[v] = Math.atan2(base[v * 3 + 1], base[v * 3]);
        const material = new THREE.MeshPhysicalMaterial({
          color: 0x0b2f28,
          metalness: 0.7,
          roughness: 0.12,
          clearcoat: 1,
          clearcoatRoughness: 0.04,
          envMapIntensity: 1.8,
          transparent: true,
          opacity: spec.opacity,
        });
        const mesh = new THREE.Mesh(geometry, material);
        group.add(mesh);
        return { spec, geometry, base, angle, material };
      });

      const deform = (t: number) => {
        for (const { spec, geometry, base, angle } of rings) {
          const pos = geometry.attributes.position.array as Float32Array;
          for (let v = 0; v < angle.length; v++) {
            const u = angle[v];
            const k = v * 3;
            const swell = 1 + 0.025 * Math.sin(2 * u - t * 0.5 + spec.phase);
            pos[k] = base[k] * swell;
            pos[k + 1] = base[k + 1] * swell;
            pos[k + 2] =
              base[k + 2] * spec.flatten +
              spec.amp * Math.sin(spec.waves * u + t * spec.speed + spec.phase) +
              spec.amp * 0.35 * Math.sin((spec.waves + 3) * u - t * 0.8);
          }
          geometry.attributes.position.needsUpdate = true;
          geometry.computeVertexNormals();
          const n = geometry.attributes.normal.array as Float32Array;
          for (let j = 0; j <= RADIAL; j++) {
            const a = (j * (TUBULAR + 1)) * 3;
            const b = (j * (TUBULAR + 1) + TUBULAR) * 3;
            for (let c = 0; c < 3; c++) n[a + c] = n[b + c] = (n[a + c] + n[b + c]) / 2;
          }
        }
      };

      const host = canvas.parentElement!;
      const resize = () => {
        const w = canvas.clientWidth || host.clientWidth;
        const h = canvas.clientHeight || host.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        group.scale.setScalar(0.74 * Math.max(0.5, Math.min(1, w / h / 1.1)));
      };
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      resize();

      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
      let mx = 0;
      let my = 0;
      const onPointer = (e: PointerEvent) => {
        mx = e.clientX / window.innerWidth - 0.5;
        my = e.clientY / window.innerHeight - 0.5;
      };
      window.addEventListener("pointermove", onPointer);

      let visible = true;
      const io = new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
      });
      io.observe(canvas);

      let t = 0;
      let last = performance.now();
      let raf = 0;
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!visible || document.hidden) return;
        t += dt * (reduceMotion.matches ? 0.1 : 1);
        deform(t);
        group.rotation.x = -1.05 + 0.08 * Math.sin(t * 0.27) + my * 0.12;
        group.rotation.y = 0.18 * Math.sin(t * 0.19) + mx * 0.18;
        group.rotation.z = t * 0.05;
        renderer.render(scene, camera);
      };
      deform(0);
      renderer.render(scene, camera);
      canvas.classList.add("on");
      raf = requestAnimationFrame(frame);

      teardown = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        window.removeEventListener("pointermove", onPointer);
        for (const r of rings) {
          r.geometry.dispose();
          r.material.dispose();
        }
        studio.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as import("three").Material).dispose();
          }
        });
        envTexture.dispose();
        pmrem.dispose();
        renderer.dispose();
      };
      if (disposed) teardown();
    })();

    return () => {
      disposed = true;
      teardown();
    };
  }, []);

  return <canvas ref={canvasRef} className="hero-canvas" aria-hidden />;
}
