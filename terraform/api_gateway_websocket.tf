# =============================================================================
# Ultra Bingo - API Gateway WebSocket API
# =============================================================================
# WebSocket API for real-time communication:
# - $connect - Handle new connections
# - $disconnect - Handle disconnections
# - $default - Handle all WebSocket messages
# - Custom routes for admin actions
# =============================================================================

# =============================================================================
# WebSocket API Definition
# =============================================================================

resource "aws_apigatewayv2_api" "websocket" {
  name                       = "${local.name_prefix}-websocket-api"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  description                = "Ultra Bingo WebSocket API for real-time game updates"

  tags = {
    Name = "${local.name_prefix}-websocket-api"
  }
}

# =============================================================================
# Lambda Integrations
# =============================================================================

# Connect Integration
resource "aws_apigatewayv2_integration" "ws_connect" {
  api_id                    = aws_apigatewayv2_api.websocket.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws_connect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

# Disconnect Integration
resource "aws_apigatewayv2_integration" "ws_disconnect" {
  api_id                    = aws_apigatewayv2_api.websocket.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws_disconnect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

# Message Integration (default handler)
resource "aws_apigatewayv2_integration" "ws_message" {
  api_id                    = aws_apigatewayv2_api.websocket.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws_message.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

# =============================================================================
# Routes
# =============================================================================

# $connect route
resource "aws_apigatewayv2_route" "ws_connect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_connect.id}"
}

# $disconnect route
resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_disconnect.id}"
}

# $default route - catches all messages
resource "aws_apigatewayv2_route" "ws_default" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ws_message.id}"
}

# Note: Custom routes removed - $default handles all message routing
# The message handler parses the 'type' field from the message body

# =============================================================================
# Stage
# =============================================================================

resource "aws_apigatewayv2_stage" "websocket" {
  api_id      = aws_apigatewayv2_api.websocket.id
  name        = var.environment
  auto_deploy = true

  # Note: access_log_settings removed - requires IAM role setup at account level
  # Can be enabled later after configuring API Gateway CloudWatch role

  default_route_settings {
    throttling_burst_limit = 500
    throttling_rate_limit  = 100
  }
}

# =============================================================================
# CloudWatch Log Group for WebSocket API Gateway
# =============================================================================

resource "aws_cloudwatch_log_group" "api_gateway_websocket" {
  name              = "/aws/apigateway/${local.name_prefix}-websocket-api"
  retention_in_days = 14
}

# =============================================================================
# Lambda Permissions for API Gateway WebSocket
# =============================================================================

resource "aws_lambda_permission" "ws_connect" {
  statement_id  = "AllowAPIGatewayWebSocketConnect"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_connect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"
}

resource "aws_lambda_permission" "ws_disconnect" {
  statement_id  = "AllowAPIGatewayWebSocketDisconnect"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"
}

resource "aws_lambda_permission" "ws_message" {
  statement_id  = "AllowAPIGatewayWebSocketMessage"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_message.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"
}

# =============================================================================
# Outputs
# =============================================================================

output "websocket_api_id" {
  description = "ID of the WebSocket API"
  value       = aws_apigatewayv2_api.websocket.id
}

output "websocket_api_endpoint" {
  description = "WebSocket API endpoint URL"
  value       = "wss://${aws_apigatewayv2_api.websocket.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.websocket.name}"
}

output "websocket_api_execution_arn" {
  description = "WebSocket API execution ARN (for Lambda permissions)"
  value       = aws_apigatewayv2_api.websocket.execution_arn
}
