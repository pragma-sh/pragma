"use client";

import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Float } from "@react-three/drei";
import type { Mesh } from "three";

/** Slowly tumbling knot; placeholder for the real landing-page animation. */
function Knot() {
  const mesh = useRef<Mesh>(null);

  useFrame((_state, delta) => {
    if (!mesh.current) return;
    mesh.current.rotation.x += delta * 0.15;
    mesh.current.rotation.y += delta * 0.2;
  });

  return (
    <Float floatIntensity={1.5} rotationIntensity={0.4} speed={1.2}>
      <mesh ref={mesh}>
        <torusKnotGeometry args={[1.1, 0.32, 220, 32]} />
        <meshStandardMaterial color="#7c7cff" metalness={0.85} roughness={0.18} />
      </mesh>
    </Float>
  );
}

/** Full-bleed react-three-fiber canvas used behind the hero copy. */
export function HeroScene({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden>
      <Canvas camera={{ position: [0, 0, 5], fov: 45 }} dpr={[1, 2]}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[4, 5, 3]} intensity={2} />
        <Knot />
        <Environment preset="city" />
      </Canvas>
    </div>
  );
}
