import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import software.amazon.dynamodb.services.local.main.ServerRunner;
import software.amazon.dynamodb.services.local.server.DynamoDBProxyServer;

// DynamoDB Local 3.3.2 does not expose a bind address in its command line.
class LocalDemoDynamo {
    public static void main(String[] args) throws Exception {
        Path data = Path.of(args[0]);
        try (var channel = FileChannel.open(data.resolve("demo.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
             var lock = channel.tryLock()) {
            if (lock == null) {
                throw new IllegalStateException("The demo database is already open.");
            }
            var database = ServerRunner.createServerFromCommandLineArgs(
                new String[] {"-sharedDb", "-dbPath", data.toString(), "-disableTelemetry"}
            );
            var serverField = DynamoDBProxyServer.class.getDeclaredField("server");
            serverField.setAccessible(true);
            if (!(serverField.get(database) instanceof Server server) || !server.isStopped()
                    || server.getConnectors().length != 1
                    || !(server.getConnectors()[0] instanceof ServerConnector connector)) {
                throw new IllegalStateException("Cannot bind this DynamoDB Local version to loopback.");
            }
            connector.setHost("127.0.0.1");
            connector.setPort(0);
            database.safeStart();
            try {
                System.out.println("CAMPUS_DEMO_DB_PORT=" + connector.getLocalPort());
                // Closing the launcher closes this pipe, including when its window is closed.
                System.in.read();
            } finally {
                database.stop();
            }
        }
    }
}
