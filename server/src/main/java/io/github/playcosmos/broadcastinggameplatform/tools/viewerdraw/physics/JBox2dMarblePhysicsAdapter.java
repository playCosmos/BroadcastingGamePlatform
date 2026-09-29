package io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.physics;

import io.github.playcosmos.broadcastinggameplatform.tools.viewerdraw.ViewerDrawService;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.jbox2d.collision.shapes.CircleShape;
import org.jbox2d.collision.shapes.PolygonShape;
import org.jbox2d.common.Vec2;
import org.jbox2d.dynamics.Body;
import org.jbox2d.dynamics.BodyDef;
import org.jbox2d.dynamics.BodyType;
import org.jbox2d.dynamics.FixtureDef;
import org.jbox2d.dynamics.World;

public final class JBox2dMarblePhysicsAdapter
    implements MarblePhysicsAdapter {

    public static final String ENGINE_ID = "JBOX2D";
    public static final String ENGINE_VERSION = "2.2.1.1-v0";

    private static final float PIXELS_PER_METER = 100.0f;
    private static final float GRAVITY_SCALE = 80.0f / PIXELS_PER_METER;
    private static final float FIXED_DT = 1.0f / 120.0f;
    private static final int VELOCITY_ITERATIONS = 8;
    private static final int POSITION_ITERATIONS = 3;
    private static final int MAX_MARBLES = 128;
    private static final double DEFAULT_TIMEOUT_SECONDS = 60.0;

    private record MarbleBody(
        String marbleId,
        Body body,
        float radiusPixels,
        boolean finished,
        int rank,
        Double finishTimeSeconds
    ) {
        private MarbleBody withFinish(
            int nextRank,
            double timeSeconds
        ) {
            return new MarbleBody(
                marbleId,
                body,
                radiusPixels,
                true,
                nextRank,
                timeSeconds
            );
        }
    }

    private record Bumper(
        String componentId,
        double x,
        double y,
        double radius,
        double boost
    ) {}

    @Override
    public String engineId() {
        return ENGINE_ID;
    }

    @Override
    public String engineVersion() {
        return ENGINE_VERSION;
    }

    @Override
    public SimulationResult simulate(
        ViewerDrawService.MachineMapDefinition definition,
        long seed,
        int marbleCount,
        double timeoutSeconds
    ) {
        validateRequest(definition, marbleCount, timeoutSeconds);

        var worldDefinition = definition.world();
        var world = new World(
            new Vec2(
                (float) (worldDefinition.gravityX() * GRAVITY_SCALE),
                (float) (worldDefinition.gravityY() * GRAVITY_SCALE)
            )
        );
        world.setAllowSleep(false);

        createWorldBounds(world, worldDefinition);

        var finishes = new ArrayList<ViewerDrawService.MachineComponent>();
        var spawns = new ArrayList<ViewerDrawService.MachineComponent>();
        var bumpers = new ArrayList<Bumper>();

        for (var component : definition.components()) {
            switch (component.type()) {
                case "WALL", "RAMP" ->
                    createStaticBox(world, component);
                case "PEG" ->
                    createStaticCircle(world, component);
                case "BUMPER" -> {
                    createStaticCircle(world, component);
                    bumpers.add(new Bumper(
                        component.id(),
                        component.x(),
                        component.y(),
                        component.radius(),
                        property(component.properties(), "boost", 1.15)
                    ));
                }
                case "SPAWN" -> spawns.add(component);
                case "FINISH" -> finishes.add(component);
                default -> throw new IllegalArgumentException(
                    "unsupported production component type: "
                        + component.type()
                );
            }
        }

        if (spawns.isEmpty() || finishes.isEmpty()) {
            throw new IllegalArgumentException(
                "production simulation requires SPAWN and FINISH"
            );
        }

        var rng = new Mulberry32(seed);
        var marbles = createMarbles(
            world,
            spawns,
            marbleCount,
            rng
        );

        var activeBumperContacts = new HashSet<String>();
        var finishOrder = new ArrayList<String>();

        double normalizedTimeout = timeoutSeconds > 0
            ? timeoutSeconds
            : DEFAULT_TIMEOUT_SECONDS;
        long maxSteps = Math.max(
            1L,
            (long) Math.ceil(normalizedTimeout / FIXED_DT)
        );

        long stepCount = 0;
        double simulatedSeconds = 0.0;

        while (
            stepCount < maxSteps
            && finishOrder.size() < marbles.size()
        ) {
            world.step(
                FIXED_DT,
                VELOCITY_ITERATIONS,
                POSITION_ITERATIONS
            );
            stepCount += 1;
            simulatedSeconds = stepCount * FIXED_DT;

            applyBumperBoosts(
                marbles,
                bumpers,
                activeBumperContacts
            );

            for (int index = 0; index < marbles.size(); index++) {
                var marble = marbles.get(index);
                if (marble.finished()) continue;

                var position = marble.body().getPosition();
                double x = position.x * PIXELS_PER_METER;
                double y = position.y * PIXELS_PER_METER;

                boolean finished = false;
                for (var finish : finishes) {
                    if (pointInRotatedRect(x, y, finish)) {
                        finished = true;
                        break;
                    }
                }

                if (!finished) continue;

                int rank = finishOrder.size() + 1;
                finishOrder.add(marble.marbleId());
                marble.body().setLinearVelocity(new Vec2());
                marble.body().setAngularVelocity(0.0f);
                marbles.set(
                    index,
                    marble.withFinish(rank, simulatedSeconds)
                );
            }
        }

        boolean timedOut = finishOrder.size() < marbles.size();
        var finalStates = new ArrayList<MarbleState>();
        for (var marble : marbles) {
            var position = marble.body().getPosition();
            finalStates.add(new MarbleState(
                marble.marbleId(),
                position.x * PIXELS_PER_METER,
                position.y * PIXELS_PER_METER,
                marble.finished(),
                marble.rank(),
                marble.finishTimeSeconds()
            ));
        }

        return new SimulationResult(
            engineId(),
            engineVersion(),
            seed,
            FIXED_DT,
            stepCount,
            simulatedSeconds,
            timedOut,
            List.copyOf(finishOrder),
            List.copyOf(finalStates)
        );
    }

    private static void validateRequest(
        ViewerDrawService.MachineMapDefinition definition,
        int marbleCount,
        double timeoutSeconds
    ) {
        if (definition == null) {
            throw new IllegalArgumentException(
                "machine map definition is required"
            );
        }
        if (
            marbleCount < 1
            || marbleCount > MAX_MARBLES
        ) {
            throw new IllegalArgumentException(
                "marbleCount must be 1.." + MAX_MARBLES
            );
        }
        if (
            !Double.isFinite(timeoutSeconds)
            || timeoutSeconds < 0
            || timeoutSeconds > 300
        ) {
            throw new IllegalArgumentException(
                "timeoutSeconds must be 0..300"
            );
        }
    }

    private static void createWorldBounds(
        World world,
        ViewerDrawService.MachineWorld definition
    ) {
        float width = px(definition.width());
        float height = px(definition.height());
        float thickness = 0.5f;

        createBoundaryBox(
            world,
            -thickness,
            height / 2.0f,
            thickness,
            height / 2.0f + thickness
        );
        createBoundaryBox(
            world,
            width + thickness,
            height / 2.0f,
            thickness,
            height / 2.0f + thickness
        );
        createBoundaryBox(
            world,
            width / 2.0f,
            -thickness,
            width / 2.0f + thickness,
            thickness
        );
        createBoundaryBox(
            world,
            width / 2.0f,
            height + thickness,
            width / 2.0f + thickness,
            thickness
        );
    }

    private static void createBoundaryBox(
        World world,
        float centerX,
        float centerY,
        float halfWidth,
        float halfHeight
    ) {
        var bodyDef = new BodyDef();
        bodyDef.type = BodyType.STATIC;
        bodyDef.position.set(centerX, centerY);
        var body = world.createBody(bodyDef);

        var shape = new PolygonShape();
        shape.setAsBox(halfWidth, halfHeight);

        var fixture = new FixtureDef();
        fixture.shape = shape;
        fixture.friction = 0.05f;
        fixture.restitution = 0.42f;
        body.createFixture(fixture);
    }

    private static void createStaticBox(
        World world,
        ViewerDrawService.MachineComponent component
    ) {
        var bodyDef = new BodyDef();
        bodyDef.type = BodyType.STATIC;
        bodyDef.position.set(
            px(component.x()),
            px(component.y())
        );
        bodyDef.angle = (float) Math.toRadians(
            component.rotation()
        );

        var body = world.createBody(bodyDef);
        var shape = new PolygonShape();
        shape.setAsBox(
            Math.max(0.01f, px(component.width()) / 2.0f),
            Math.max(0.01f, px(component.height()) / 2.0f)
        );

        var fixture = new FixtureDef();
        fixture.shape = shape;
        fixture.friction = (float) clamp(
            property(component.properties(), "friction", 0.05),
            0,
            0.5
        );
        fixture.restitution = (float) clamp(
            property(
                component.properties(),
                "restitution",
                0.35
            ),
            0,
            1.4
        );
        body.createFixture(fixture);
    }

    private static void createStaticCircle(
        World world,
        ViewerDrawService.MachineComponent component
    ) {
        var bodyDef = new BodyDef();
        bodyDef.type = BodyType.STATIC;
        bodyDef.position.set(
            px(component.x()),
            px(component.y())
        );

        var body = world.createBody(bodyDef);
        var shape = new CircleShape();
        shape.m_radius = Math.max(
            0.01f,
            px(component.radius())
        );

        var fixture = new FixtureDef();
        fixture.shape = shape;
        fixture.friction = (float) clamp(
            property(component.properties(), "friction", 0.03),
            0,
            0.5
        );
        fixture.restitution = (float) clamp(
            property(
                component.properties(),
                "restitution",
                "BUMPER".equals(component.type())
                    ? 0.95
                    : 0.55
            ),
            0,
            1.4
        );
        body.createFixture(fixture);
    }

    private static ArrayList<MarbleBody> createMarbles(
        World world,
        List<ViewerDrawService.MachineComponent> spawns,
        int marbleCount,
        Mulberry32 rng
    ) {
        var result = new ArrayList<MarbleBody>();

        for (int index = 0; index < marbleCount; index++) {
            var spawn = spawns.get(index % spawns.size());
            double radiusPixels = clamp(
                property(
                    spawn.properties(),
                    "marbleRadius",
                    11
                ),
                5,
                24
            );
            int ring = index / spawns.size();
            double angle =
                index * 2.399963229728653
                    + (rng.nextDouble() - 0.5) * 0.2;
            double spread =
                (ring + 1)
                    * Math.min(radiusPixels * 1.5, 18);

            double x =
                spawn.x() + Math.cos(angle) * spread;
            double y =
                spawn.y() + Math.sin(angle) * spread;

            var bodyDef = new BodyDef();
            bodyDef.type = BodyType.DYNAMIC;
            bodyDef.position.set(px(x), px(y));
            bodyDef.linearVelocity.set(
                (float) (
                    (rng.nextDouble() - 0.5)
                        * 35.0
                        / PIXELS_PER_METER
                ),
                (float) (
                    (rng.nextDouble() - 0.5)
                        * 8.0
                        / PIXELS_PER_METER
                )
            );
            bodyDef.fixedRotation = true;
            bodyDef.bullet = true;
            bodyDef.allowSleep = false;
            bodyDef.linearDamping = 0.06f;

            var body = world.createBody(bodyDef);
            var shape = new CircleShape();
            shape.m_radius = px(radiusPixels);

            var fixture = new FixtureDef();
            fixture.shape = shape;
            fixture.density = 1.0f;
            fixture.friction = 0.03f;
            fixture.restitution = 0.62f;
            body.createFixture(fixture);

            result.add(new MarbleBody(
                "m" + (index + 1),
                body,
                (float) radiusPixels,
                false,
                0,
                null
            ));
        }

        return result;
    }

    private static void applyBumperBoosts(
        List<MarbleBody> marbles,
        List<Bumper> bumpers,
        Set<String> activeContacts
    ) {
        var nextContacts = new HashSet<String>();

        for (var marble : marbles) {
            if (marble.finished()) continue;

            var position = marble.body().getPosition();
            double x = position.x * PIXELS_PER_METER;
            double y = position.y * PIXELS_PER_METER;

            for (var bumper : bumpers) {
                double dx = x - bumper.x();
                double dy = y - bumper.y();
                double distance = Math.hypot(dx, dy);
                double contactDistance =
                    marble.radiusPixels()
                        + bumper.radius()
                        + 2.0;

                if (distance > contactDistance) continue;

                String key =
                    marble.marbleId() + "|" + bumper.componentId();
                nextContacts.add(key);

                if (
                    activeContacts.contains(key)
                    || bumper.boost() <= 0
                ) {
                    continue;
                }

                if (distance < 1.0e-6) {
                    dx = 1.0;
                    dy = 0.0;
                    distance = 1.0;
                }

                double nx = dx / distance;
                double ny = dy / distance;
                double deltaVelocity =
                    clamp(bumper.boost(), 0, 3)
                        * 70.0
                        / PIXELS_PER_METER;
                float impulse =
                    (float) (
                        marble.body().getMass()
                            * deltaVelocity
                    );

                marble.body().applyLinearImpulse(
                    new Vec2(
                        (float) (nx * impulse),
                        (float) (ny * impulse)
                    ),
                    marble.body().getWorldCenter(),
                    true
                );
            }
        }

        activeContacts.clear();
        activeContacts.addAll(nextContacts);
    }

    private static boolean pointInRotatedRect(
        double x,
        double y,
        ViewerDrawService.MachineComponent component
    ) {
        double angle = Math.toRadians(
            component.rotation()
        );
        double cos = Math.cos(angle);
        double sin = Math.sin(angle);
        double dx = x - component.x();
        double dy = y - component.y();
        double localX = dx * cos + dy * sin;
        double localY = -dx * sin + dy * cos;
        return Math.abs(localX)
                <= component.width() / 2.0
            && Math.abs(localY)
                <= component.height() / 2.0;
    }

    private static double property(
        Map<String, Object> properties,
        String key,
        double fallback
    ) {
        if (properties == null) return fallback;
        Object value = properties.get(key);
        if (value instanceof Number number) {
            double result = number.doubleValue();
            return Double.isFinite(result)
                ? result
                : fallback;
        }
        if (value instanceof String text) {
            try {
                double result = Double.parseDouble(text.trim());
                return Double.isFinite(result)
                    ? result
                    : fallback;
            } catch (NumberFormatException ignored) {}
        }
        return fallback;
    }

    private static float px(double pixels) {
        return (float) (
            pixels / PIXELS_PER_METER
        );
    }

    private static double clamp(
        double value,
        double min,
        double max
    ) {
        return Math.max(min, Math.min(max, value));
    }

    private static final class Mulberry32 {
        private int state;

        private Mulberry32(long seed) {
            state = (int) seed;
            if (state == 0) {
                state = 0x6d2b79f5;
            }
        }

        private double nextDouble() {
            state += 0x6d2b79f5;
            int t = state;
            t = (t ^ (t >>> 15)) * (t | 1);
            t ^= t + (
                (t ^ (t >>> 7)) * (t | 61)
            );
            int value = t ^ (t >>> 14);
            return Integer.toUnsignedLong(value)
                / 4294967296.0;
        }
    }
}
